import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { newBookingNumber, withBookingNumber } from '../bookings/booking-rules.js';
import type { AvailableDays, BookingSeries, Prisma, Slot, Weekday } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addDays, fromDbDate, toDbDate, venueNow, type IsoDate, type VenueNow } from '../slots/venue-time.js';
import { seriesDates, skipReasonOf, type SkipReason } from './booking-series-rules.js';

type Db = PrismaService | Prisma.TransactionClient;
type GroundDaysOnly = { availableDays: AvailableDays; customDays: Weekday[] };

/** One matching date: the slot at the series' hour (if any) and why it can't be booked (null = it can). */
export interface DatePlan {
  date: IsoDate;
  slot: Slot | null;
  reason: SkipReason | null;
}

/** A booking the series just made. */
export interface BookedDate {
  id: string;
  date: IsoDate;
  total: number;
}

/** Large ranges (an ongoing series over a long booking window) write many rows in one transaction. */
export const SERIES_TX = { timeout: 60_000 } as const;

/** The latest date the ground has any slot for: how far an ongoing series can book right now. */
export async function lastSlotDate(db: Db, groundId: string): Promise<IsoDate | null> {
  const last = await db.slot.findFirst({ where: { groundId }, orderBy: { date: 'desc' }, select: { date: true } });
  return last ? fromDbDate(last.date) : null;
}

/**
 * Books a series' dates: shared by creation and the hourly extend, so both skip the same way.
 * Each free slot is taken with a conditional update (available → booked); one taken meanwhile
 * becomes a skip. Skips are unique per series and date.
 */
@Injectable()
export class BookingSeriesBooker {
  private readonly logger = new Logger(BookingSeriesBooker.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The slot at `startHour` on each date, and whether it can be booked. */
  async survey(db: Db, groundId: string, ground: GroundDaysOnly, startHour: number, dates: IsoDate[], now: VenueNow): Promise<DatePlan[]> {
    if (dates.length === 0) return [];
    const slots = await db.slot.findMany({ where: { groundId, startHour, date: { in: dates.map(toDbDate) } } });
    const byDate = new Map(slots.map((s) => [fromDbDate(s.date), s]));
    return dates.map((date) => {
      const slot = byDate.get(date) ?? null;
      return { date, slot, reason: skipReasonOf(ground, date, slot ?? undefined, now) };
    });
  }

  /** Books every free date (confirmed, unpaid, no emails) and records the rest as skips. Run inside a transaction. */
  async book(
    tx: Prisma.TransactionClient, series: BookingSeries, ground: GroundDaysOnly, dates: IsoDate[], actorId: string | null, now: VenueNow,
  ): Promise<BookedDate[]> {
    const plans = await this.survey(tx, series.groundId, ground, series.startHour, dates, now);
    const free = plans.filter((p) => p.reason === null).map((p) => p.slot!);
    const taken = free.length === 0 ? [] : await tx.slot.updateManyAndReturn({
      where: { id: { in: free.map((s) => s.id) }, status: 'available' }, data: { status: 'booked' },
    });
    const takenIds = new Set(taken.map((s) => s.id));
    const booked = free.filter((s) => takenIds.has(s.id)).map((slot) => ({ id: randomUUID(), slot }));
    // A slot booked, held or blocked since the survey: the series loses it, like any busy date.
    const skips = plans.filter((p) => p.reason !== null || !takenIds.has(p.slot!.id))
      .map((p) => ({ seriesId: series.id, date: toDbDate(p.date), reason: p.reason ?? 'booked' }));

    await tx.booking.createMany({ data: booked.map(({ id, slot }) => newSeriesBooking(id, series, slot, actorId)) });
    await tx.bookingEvent.createMany({
      data: booked.flatMap(({ id }) => [
        { bookingId: id, type: 'created' as const, userId: actorId, detail: 'Booked as part of a repeat booking' },
        { bookingId: id, type: 'confirmed' as const, userId: actorId, detail: 'Confirmed as part of a repeat booking' },
      ]),
    });
    await tx.bookingSeriesSkip.createMany({ data: skips, skipDuplicates: true });
    return booked.map(({ id, slot }) => ({ id, date: fromDbDate(slot.date), total: slot.price })).sort((a, b) => a.date.localeCompare(b.date));
  }

  /** The hourly job: extends every active ongoing series. One failing is logged and doesn't stop the others. */
  async extendOngoing(): Promise<number> {
    const series = await this.prisma.bookingSeries.findMany({
      where: { status: 'active', untilDate: null, deletedAt: null, ground: { isActive: true } }, select: { id: true },
    });
    let booked = 0;
    for (const { id } of series) {
      try {
        booked += await this.extend(id);
      } catch (err) {
        this.logger.error(`Could not extend repeat booking ${id}`, err instanceof Error ? err.stack : String(err));
      }
    }
    return booked;
  }

  /**
   * Books an ongoing series from the day after `bookedThrough` up to the ground's latest slot.
   * Claims the range first (compare-and-set on `bookedThrough`), so two runs never book it twice:
   * the second finds it moved and does nothing. A stopped series or inactive ground is left alone.
   */
  async extend(seriesId: string): Promise<number> {
    const series = await this.prisma.bookingSeries.findUnique({ where: { id: seriesId }, include: { ground: true } });
    if (!series || series.status !== 'active' || series.untilDate || series.deletedAt || !series.ground.isActive) return 0;
    const from = series.bookedThrough ? addDays(fromDbDate(series.bookedThrough), 1) : fromDbDate(series.fromDate);
    const horizon = await lastSlotDate(this.prisma, series.groundId);
    if (!horizon || horizon < from) return 0;
    const dates = seriesDates(from, horizon, series.weekdays);

    return withBookingNumber(() => this.prisma.$transaction(async (tx) => {
      const { count } = await tx.bookingSeries.updateMany({
        where: { id: seriesId, status: 'active', bookedThrough: series.bookedThrough }, data: { bookedThrough: toDbDate(horizon) },
      });
      if (count === 0) return 0;
      return (await this.book(tx, series, series.ground, dates, series.createdById, venueNow())).length;
    }, SERIES_TX));
  }
}

function newSeriesBooking(id: string, series: BookingSeries, slot: Slot, actorId: string | null): Prisma.BookingCreateManyInput {
  return {
    id, bookingNumber: newBookingNumber(), source: 'staff', groundId: slot.groundId, slotId: slot.id, liveSlotId: slot.id,
    customerId: series.customerId, contactName: series.contactName, contactPhone: series.contactPhone, contactEmail: series.contactEmail,
    status: 'confirmed', paymentStatus: 'unpaid', confirmedAt: new Date(), payAtVenue: false,
    amount: slot.price, serviceFee: 0, total: slot.price, notes: series.notes, createdById: actorId, seriesId: series.id,
  };
}
