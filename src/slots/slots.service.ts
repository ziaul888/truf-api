import { Injectable } from '@nestjs/common';
import type { Paginated } from '../common/schemas.js';
import type { Prisma, SlotStatus } from '../generated/prisma/client.js';
import { peakRangesOf } from '../grounds/ground.dto.js';
import { VISIBLE_GROUND } from '../grounds/ground-rules.js';
import { isOpenOn, isPeakHour } from '../grounds/ground-schedule.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { paidOf } from '../bookings/booking-rules.js';
import { endHourOf, SLOT_INCLUDE, toSlotDto, type PublicSlotDto, type SlotDto, type SlotRow } from './slot.dto.js';
import { SlotSettingsService } from './slot-settings.service.js';
import { activeClosuresWhere, assertRange, closureOn, dateWhere, groundNotFound, slotNotFound } from './slot-rules.js';
import type { CalendarQuery, ListSlotsQuery, PublicSlotsQuery } from './slots.schemas.js';
import { addDays, fromDbDate, minutesUntil, venueNow, weekdayOf, type IsoDate } from './venue-time.js';

export const MAX_PUBLIC_DAYS = 14;
export const MAX_CALENDAR_DAYS = 62;
const MAX_LIST_DAYS = 366;

export type SlotStats = Record<SlotStatus | 'total', number>;

export interface CalendarSlot {
  id: string;
  groundId: string;
  groundName: string;
  date: IsoDate;
  startHour: number;
  endHour: number;
  status: SlotStatus;
  /** Blocked slots: the reason, plus the note if any. */
  note?: string;
  /** Booked and held slots: from the live booking. */
  bookingId?: string;
  customerName?: string;
  customerPhone?: string;
  amount?: number;
  advancePaid?: number;
}

export interface Calendar {
  slots: CalendarSlot[];
  totals: { date: IsoDate; groundId: string; totalSlots: number }[];
}

function toCalendarSlot(s: SlotRow): CalendarSlot {
  const booking = s.bookings[0];
  return {
    id: s.id, groundId: s.groundId, groundName: s.ground.name, date: fromDbDate(s.date),
    startHour: s.startHour, endHour: endHourOf(s), status: s.status,
    ...(s.status === 'blocked' && s.blockReason && { note: s.blockNote ? `${s.blockReason}: ${s.blockNote}` : s.blockReason }),
    ...(booking && {
      bookingId: booking.id, customerName: booking.contactName, customerPhone: booking.contactPhone,
      amount: booking.total, advancePaid: paidOf(booking.payments),
    }),
  };
}

const ORDER: Prisma.SlotOrderByWithRelationInput[] = [{ date: 'asc' }, { startHour: 'asc' }, { ground: { name: 'asc' } }];

@Injectable()
export class SlotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SlotSettingsService,
  ) {}

  /** `stats` cover the same ground and dates but ignore the status and reason filters (the stat cards). */
  async list({ page, limit, groundId, from, to, status, reason }: ListSlotsQuery): Promise<Paginated<SlotDto> & { stats: SlotStats }> {
    if (from && to) assertRange(from, to, MAX_LIST_DAYS);
    const base: Prisma.SlotWhereInput = { ...(groundId && { groundId }), ...dateWhere(from, to) };
    const where: Prisma.SlotWhereInput = { ...base, ...(status && { status }), ...(reason && { blockReason: reason }) };
    const [rows, total, counts] = await this.prisma.$transaction([
      this.prisma.slot.findMany({ where, include: SLOT_INCLUDE, orderBy: ORDER, skip: (page - 1) * limit, take: limit }),
      this.prisma.slot.count({ where }),
      this.prisma.slot.groupBy({ by: ['status'], where: base, orderBy: { status: 'asc' }, _count: { _all: true } }),
    ]);
    const stats: SlotStats = { total: 0, available: 0, held: 0, booked: 0, blocked: 0 };
    for (const c of counts) {
      const n = (c._count as { _all: number })._all;
      stats[c.status] = n;
      stats.total += n;
    }
    return { data: rows.map(toSlotDto), total, page, limit, stats };
  }

  async get(id: string): Promise<SlotDto> {
    const slot = await this.prisma.slot.findUnique({ where: { id }, include: SLOT_INCLUDE });
    if (!slot) throw slotNotFound();
    return toSlotDto(slot);
  }

  /** Held, booked and blocked slots only, plus each ground's slot count per day. */
  async calendar({ from, to, groundId }: CalendarQuery): Promise<Calendar> {
    assertRange(from, to, MAX_CALENDAR_DAYS);
    const base: Prisma.SlotWhereInput = { ...(groundId && { groundId }), ...dateWhere(from, to) };
    const [rows, counts] = await this.prisma.$transaction([
      this.prisma.slot.findMany({ where: { ...base, status: { in: ['held', 'booked', 'blocked'] } }, include: SLOT_INCLUDE, orderBy: ORDER }),
      this.prisma.slot.groupBy({ by: ['date', 'groundId'], where: base, orderBy: [{ date: 'asc' }, { groundId: 'asc' }], _count: { _all: true } }),
    ]);
    return {
      slots: rows.map(toCalendarSlot),
      totals: counts.map((c) => ({
        date: fromDbDate(c.date), groundId: c.groundId, totalSlots: (c._count as { _all: number })._all,
      })),
    };
  }

  /**
   * Customer availability for one visible ground. `available` is only true for free slots that
   * start after the cancellation cutoff and fall inside the booking window. Closed days (the ground's
   * days off, or a venue closure) return nothing.
   */
  async listPublic(groundId: string, { from, to }: PublicSlotsQuery): Promise<PublicSlotDto[]> {
    assertRange(from, to, MAX_PUBLIC_DAYS);
    const ground = await this.prisma.ground.findFirst({ where: { id: groundId, ...VISIBLE_GROUND } });
    if (!ground) throw groundNotFound();
    const { advanceBookingDays, cancellationCutoffHours } = await this.settings.get();
    const [rows, closures] = await Promise.all([
      this.prisma.slot.findMany({ where: { groundId, ...dateWhere(from, to) }, orderBy: [{ date: 'asc' }, { startHour: 'asc' }] }),
      this.prisma.closure.findMany({ where: activeClosuresWhere(groundId, from, to) }),
    ]);

    const now = venueNow();
    const lastBookable = addDays(now.date, advanceBookingDays);
    const schedule = { ...ground, peakRanges: peakRangesOf(ground) };
    return rows
      .filter((s) => isOpenOn(ground, weekdayOf(fromDbDate(s.date))) && !closureOn(closures, fromDbDate(s.date)))
      .map((s) => {
        const date = fromDbDate(s.date);
        const endHour = endHourOf(s);
        return {
          id: s.id, date, startHour: s.startHour, endHour, price: s.price,
          isPeak: Array.from({ length: endHour - s.startHour }, (_, i) => s.startHour + i).some((h) => isPeakHour(schedule, h)),
          available: s.status === 'available' && date <= lastBookable
            && minutesUntil(now, date, s.startHour) > cancellationCutoffHours * 60,
        };
      });
  }
}
