import { Injectable } from '@nestjs/common';
import type { Prisma, SlotStatus } from '../generated/prisma/client.js';
import { peakRangesOf } from '../grounds/ground.dto.js';
import { VISIBLE_GROUND } from '../grounds/ground-rules.js';
import { isOpenOn, isPeakSlot } from '../grounds/ground-schedule.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { paidOf } from '../bookings/booking-rules.js';
import {
  liveBookingOf,
  SLOT_INCLUDE,
  toSlotDto,
  type PublicSlotDto,
  type SlotDto,
  type SlotRow,
} from './slot.dto.js';
import { SlotSettingsService } from './slot-settings.service.js';
import { listAdminSlots, SLOT_ORDER } from './slot-list.js';
import {
  activeClosuresWhere,
  assertRange,
  closureOn,
  dateWhere,
  groundNotFound,
  slotNotFound,
} from './slot-rules.js';
import type {
  CalendarQuery,
  ListSlotsQuery,
  PublicSlotsQuery,
} from './slots.schemas.js';
import { slotHour, slotTimes, type SlotTimes } from './slot-time.js';
import {
  addDays,
  fromDbDate,
  minutesUntil,
  venueNow,
  weekdayOf,
  type IsoDate,
} from './venue-time.js';

export const MAX_PUBLIC_DAYS = 14;
export const MAX_CALENDAR_DAYS = 62;

export interface CalendarSlot extends SlotTimes {
  id: string;
  groundId: string;
  groundName: string;
  date: IsoDate;
  status: SlotStatus;
  /** Blocked slots: the reason, plus the note if any. */
  note?: string;
  /** Booked and held slots: from the live booking. */
  bookingId?: string;
  customerName?: string;
  customerPhone?: string;
  /** The BOOKING total, repeated on every slot of a multi-slot booking (don't sum it over slots). */
  amount?: number;
  advancePaid?: number;
  /** How many slots the booking holds. */
  slotCount?: number;
  /** This slot's own price. */
  price?: number;
}

export interface Calendar {
  slots: CalendarSlot[];
  totals: { date: IsoDate; groundId: string; totalSlots: number }[];
}

function toCalendarSlot(s: SlotRow): CalendarSlot {
  const booking = liveBookingOf(s);
  return {
    id: s.id,
    groundId: s.groundId,
    groundName: s.ground.name,
    date: fromDbDate(s.date),
    ...slotTimes(s),
    status: s.status,
    ...(s.status === 'blocked' &&
      s.blockReason && {
        note: s.blockNote ? `${s.blockReason}: ${s.blockNote}` : s.blockReason,
      }),
    ...(booking && {
      bookingId: booking.id,
      customerName: booking.contactName,
      customerPhone: booking.contactPhone,
      amount: booking.total,
      advancePaid: paidOf(booking.payments),
      slotCount: booking._count.bookingSlots || 1,
      price: s.price,
    }),
  };
}

export async function slotCalendar(
  db: PrismaService,
  { from, to, groundId }: CalendarQuery,
): Promise<Calendar> {
  assertRange(from, to, MAX_CALENDAR_DAYS);
  const base: Prisma.SlotWhereInput = { groundId, ...dateWhere(from, to) };
  const [rows, counts] = await db.$transaction([
    db.slot.findMany({
      where: { ...base, status: { in: ['held', 'booked', 'blocked'] } },
      include: SLOT_INCLUDE,
      orderBy: SLOT_ORDER,
    }),
    db.slot.groupBy({
      by: ['date', 'groundId'],
      where: base,
      orderBy: [{ date: 'asc' }, { groundId: 'asc' }],
      _count: { _all: true },
    }),
  ]);
  return {
    slots: rows.map(toCalendarSlot),
    totals: counts.map((c) => ({
      date: fromDbDate(c.date),
      groundId: c.groundId,
      totalSlots: (c._count as { _all: number })._all,
    })),
  };
}

@Injectable()
export class SlotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SlotSettingsService,
  ) {}

  list(query: ListSlotsQuery) {
    return listAdminSlots(this.prisma, query);
  }

  async get(id: string): Promise<SlotDto> {
    const slot = await this.prisma.slot.findUnique({
      where: { id },
      include: SLOT_INCLUDE,
    });
    if (!slot) throw slotNotFound();
    return toSlotDto(slot);
  }

  /** Held, booked and blocked slots only, plus each ground's slot count per day. */
  calendar(query: CalendarQuery): Promise<Calendar> {
    return slotCalendar(this.prisma, query);
  }

  /**
   * Customer availability for one visible ground. `available` is only true for free slots that
   * start after the cancellation cutoff and fall inside the booking window. Closed days (the ground's
   * days off, or a venue closure) return nothing.
   */
  async listPublic(
    groundId: string,
    { from, to }: PublicSlotsQuery,
  ): Promise<PublicSlotDto[]> {
    assertRange(from, to, MAX_PUBLIC_DAYS);
    const ground = await this.prisma.ground.findFirst({
      where: { id: groundId, ...VISIBLE_GROUND },
    });
    if (!ground) throw groundNotFound();
    const { advanceBookingDays, cancellationCutoffHours } =
      await this.settings.get();
    const [rows, closures] = await Promise.all([
      this.prisma.slot.findMany({
        where: { groundId, ...dateWhere(from, to) },
        orderBy: [
          { date: 'asc' },
          { startHour: 'asc' },
          { startMinute: 'asc' },
        ],
      }),
      this.prisma.closure.findMany({
        where: activeClosuresWhere(groundId, from, to),
      }),
    ]);

    const now = venueNow();
    const lastBookable = addDays(now.date, advanceBookingDays);
    const schedule = { ...ground, peakRanges: peakRangesOf(ground) };
    return rows
      .filter(
        (s) =>
          isOpenOn(ground, weekdayOf(fromDbDate(s.date))) &&
          !closureOn(closures, fromDbDate(s.date)),
      )
      .map((s) => {
        const date = fromDbDate(s.date);
        return {
          id: s.id,
          date,
          ...slotTimes(s),
          price: s.price,
          // The slot's own length: it may predate a change to the ground's.
          isPeak: isPeakSlot(
            { ...schedule, slotDurationMinutes: s.durationMinutes },
            s.startHour,
            s.startMinute,
          ),
          available:
            s.status === 'available' &&
            date <= lastBookable &&
            minutesUntil(now, date, slotHour(s)) > cancellationCutoffHours * 60,
        };
      });
  }
}
