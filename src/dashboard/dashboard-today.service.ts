import { Injectable } from '@nestjs/common';
import { dueOf } from '../bookings/booking-rules.js';
import type { Closure, Prisma, SlotStatus, Sport } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { loadMoney, moneyTotals, type MoneyEvent } from '../reports/report-data.js';
import { minutesUntil, toDbDate, venueNow, type IsoDate, type VenueNow } from '../slots/venue-time.js';

const TODAY_SLOT_SELECT = {
  groundId: true, startHour: true, durationMinutes: true, status: true, closureId: true,
  bookings: {
    where: { liveSlotId: { not: null } }, take: 1,
    select: {
      id: true, bookingNumber: true, contactName: true, status: true, total: true,
      payments: { where: { deletedAt: null }, select: { amount: true, status: true } },
    },
  },
} satisfies Prisma.SlotSelect;

type TodaySlot = Prisma.SlotGetPayload<{ select: typeof TODAY_SLOT_SELECT }>;

export interface PlayingBooking {
  bookingId: string;
  bookingNumber: string;
  customerName: string;
  startHour: number;
  endHour: number;
}

export interface GroundToday {
  groundId: string;
  groundName: string;
  sport: Sport;
  format: string | null;
  openingHour: number;
  closingHour: number;
  /** Set when the ground doesn't open today: a closure's label, or "Not open today". */
  closedReason: string | null;
  slots: Record<SlotStatus | 'total', number>;
  bookedHours: number;
  remainingFreeHours: number;
  revenueToday: number;
  current: PlayingBooking | null;
  next: (PlayingBooking & { due: number }) | null;
  timeline: { startHour: number; endHour: number; status: SlotStatus }[];
}

export interface DashboardToday {
  date: IsoDate;
  nowHour: number;
  grounds: GroundToday[];
}

type Ground = { id: string; name: string; sport: Sport; format: string | null; openingHour: number; closingHour: number };

const endOf = (s: TodaySlot) => s.startHour + s.durationMinutes / 60;
const playing = (s: TodaySlot): PlayingBooking => ({
  bookingId: s.bookings[0]!.id, bookingNumber: s.bookings[0]!.bookingNumber, customerName: s.bookings[0]!.contactName,
  startHour: s.startHour, endHour: endOf(s),
});

/** "Today's grounds" on the dashboard: each active ground's slots, who's on now and who's next. */
@Injectable()
export class DashboardTodayService {
  constructor(private readonly prisma: PrismaService) {}

  async today(): Promise<DashboardToday> {
    const now = venueNow();
    const date = toDbDate(now.date);
    const [grounds, slots, closures, money] = await Promise.all([
      this.prisma.ground.findMany({
        where: { isActive: true }, orderBy: { name: 'asc' },
        select: { id: true, name: true, sport: true, format: true, openingHour: true, closingHour: true },
      }),
      this.prisma.slot.findMany({ where: { date, ground: { isActive: true } }, orderBy: { startHour: 'asc' }, select: TODAY_SLOT_SELECT }),
      this.prisma.closure.findMany({ where: { liftedAt: null, fromDate: { lte: date }, toDate: { gte: date } } }),
      loadMoney(this.prisma, { from: now.date, to: now.date }),
    ]);
    return {
      date: now.date, nowHour: Math.floor(now.minutes / 60),
      grounds: grounds.map((g) => groundToday(g, slots, closures, money, now)),
    };
  }
}

/** One ground's day. Exported for tests. */
export function groundToday(g: Ground, all: TodaySlot[], closures: Closure[], money: MoneyEvent[], now: VenueNow): GroundToday {
  const closure = closures.find((c) => c.groundIds.length === 0 || c.groundIds.includes(g.id));
  // A closure's own blocks aren't shown; a booking it had to skip still is.
  const slots = all.filter((s) => s.groundId === g.id && !(closure && s.closureId));
  const counts = { total: slots.length, available: 0, held: 0, booked: 0, blocked: 0 };
  for (const s of slots) counts[s.status] += 1;
  const hours = (list: TodaySlot[]) => list.reduce((sum, s) => sum + s.durationMinutes / 60, 0);
  const started = (hour: number) => minutesUntil(now, now.date, hour) <= 0;
  const booked = slots.filter((s) => s.status === 'booked' && s.bookings.length > 0);
  const current = booked.find((s) => started(s.startHour) && !started(endOf(s)));
  const next = booked.find((s) => !started(s.startHour));
  return {
    groundId: g.id, groundName: g.name, sport: g.sport, format: g.format, openingHour: g.openingHour, closingHour: g.closingHour,
    closedReason: closure ? (closure.publicLabel ?? 'Closed') : slots.length === 0 ? 'Not open today' : null,
    slots: counts,
    bookedHours: hours(slots.filter((s) => s.status === 'booked')),
    remainingFreeHours: hours(slots.filter((s) => s.status === 'available' && !started(s.startHour))),
    revenueToday: moneyTotals(money.filter((e) => e.groundId === g.id)).revenue,
    current: current ? playing(current) : null,
    next: next ? { ...playing(next), due: dueOf(next.bookings[0]!, next.bookings[0]!.payments) } : null,
    timeline: slots.map((s) => ({ startHour: s.startHour, endHour: endOf(s), status: s.status })),
  };
}
