import { Injectable } from '@nestjs/common';
import type { Paginated } from '../common/schemas.js';
import type { Prisma, SlotStatus } from '../generated/prisma/client.js';
import { peakRangesOf } from '../grounds/ground.dto.js';
import { VISIBLE_GROUND } from '../grounds/ground-rules.js';
import { isOpenOn, isPeakSlot } from '../grounds/ground-schedule.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { paidOf } from '../bookings/booking-rules.js';
import { SLOT_INCLUDE, toSlotDto, type PublicSlotDto, type SlotDto, type SlotRow } from './slot.dto.js';
import { SlotSettingsService } from './slot-settings.service.js';
import { activeClosuresWhere, assertRange, closureOn, dateWhere, groundNotFound, isOpenDay, slotNotFound } from './slot-rules.js';
import type { CalendarQuery, ListSlotsQuery, PublicSlotsQuery } from './slots.schemas.js';
import { slotHour, slotTimes, type SlotTimes } from './slot-time.js';
import { addDays, datesBetween, fromDbDate, minutesUntil, toDbDate, venueNow, weekdayOf, type IsoDate } from './venue-time.js';

export const MAX_PUBLIC_DAYS = 14;
export const MAX_CALENDAR_DAYS = 62;
const MAX_LIST_DAYS = 366;

export type SlotStats = Record<SlotStatus | 'total', number>;

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
    ...slotTimes(s), status: s.status,
    ...(s.status === 'blocked' && s.blockReason && { note: s.blockNote ? `${s.blockReason}: ${s.blockNote}` : s.blockReason }),
    ...(booking && {
      bookingId: booking.id, customerName: booking.contactName, customerPhone: booking.contactPhone,
      amount: booking.total, advancePaid: paidOf(booking.payments),
    }),
  };
}

const ORDER: Prisma.SlotOrderByWithRelationInput[] = [{ date: 'asc' }, { startHour: 'asc' }, { startMinute: 'asc' }, { ground: { name: 'asc' } }];

@Injectable()
export class SlotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SlotSettingsService,
  ) {}

  /** `stats` cover the same ground and dates but ignore the status, reason and open-day filters (the stat cards). */
  async list({ page, limit, groundId, from, to, status, reason, openDaysOnly }: ListSlotsQuery): Promise<Paginated<SlotDto> & { stats: SlotStats }> {
    if (from && to) assertRange(from, to, MAX_LIST_DAYS);
    const base: Prisma.SlotWhereInput = { ...(groundId && { groundId }), ...dateWhere(from, to) };
    const where: Prisma.SlotWhereInput = {
      ...base, ...(status && { status }), ...(reason && { blockReason: reason }),
      ...(openDaysOnly && await this.openDatesWhere(groundId!, from!, to!)),
    };
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

  private async openDatesWhere(groundId: string, from: IsoDate, to: IsoDate): Promise<Prisma.SlotWhereInput> {
    const ground = await this.prisma.ground.findUnique({ where: { id: groundId } });
    const open = ground ? datesBetween(from, to).filter((date) => isOpenDay(ground, date)) : [];
    return { date: { in: open.map(toDbDate) } };
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
      this.prisma.slot.findMany({ where: { groundId, ...dateWhere(from, to) }, orderBy: [{ date: 'asc' }, { startHour: 'asc' }, { startMinute: 'asc' }] }),
      this.prisma.closure.findMany({ where: activeClosuresWhere(groundId, from, to) }),
    ]);

    const now = venueNow();
    const lastBookable = addDays(now.date, advanceBookingDays);
    const schedule = { ...ground, peakRanges: peakRangesOf(ground) };
    return rows
      .filter((s) => isOpenOn(ground, weekdayOf(fromDbDate(s.date))) && !closureOn(closures, fromDbDate(s.date)))
      .map((s) => {
        const date = fromDbDate(s.date);
        return {
          id: s.id, date, ...slotTimes(s), price: s.price,
          // The slot's own length: it may predate a change to the ground's.
          isPeak: isPeakSlot({ ...schedule, slotDurationMinutes: s.durationMinutes }, s.startHour, s.startMinute),
          available: s.status === 'available' && date <= lastBookable
            && minutesUntil(now, date, slotHour(s)) > cancellationCutoffHours * 60,
        };
      });
  }
}
