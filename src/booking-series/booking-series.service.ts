import { Injectable, Logger } from '@nestjs/common';
import { BookingCancellationService } from '../bookings/booking-cancellation.service.js';
import { dueOf, paymentUnderReview, pendingWalletPayment, withBookingNumber, withUniqueReference } from '../bookings/booking-rules.js';
import { AppError } from '../common/app-error.js';
import { contactEmailOf, upsertCustomerByPhone } from '../customers/customer-upsert.js';
import type { Ground, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { groundNotFound } from '../slots/slot-rules.js';
import { slotHour } from '../slots/slot-time.js';
import { fromDbDate, hasStarted, toDbDate, venueNow, type IsoDate } from '../slots/venue-time.js';
import { BookingSeriesBooker, lastSlotDate, SERIES_TX, type BookedDate } from './booking-series-booker.js';
import { recordAllocated } from './booking-series-payments.js';
import { amountExceedsDue, monthRange, nothingToBook, seriesDates, seriesNotFound, seriesStopped, type SkipReason } from './booking-series-rules.js';
import { SERIES_INCLUDE, toSeriesDto, type SeriesDto } from './booking-series.dto.js';
import type { CreateSeriesInput, PreviewSeriesInput, SeriesPaymentRecordInput, StopSeriesInput } from './booking-series.schemas.js';

export interface SeriesPreview {
  dates: { date: IsoDate; slotId: string | null; price: number | null; available: boolean; reason?: SkipReason }[];
  bookableCount: number;
  total: number;
  /** The last date covered: untilDate, or for an ongoing series the ground's latest slot. */
  horizon: IsoDate;
}

const exceedsDue = (message: string) => new AppError(message, 400, 'PAYMENT_EXCEEDS_DUE');

/** Repeat bookings made by staff: one ground and hour on chosen weekdays, each date its own normal booking. */
@Injectable()
export class BookingSeriesService {
  private readonly logger = new Logger(BookingSeriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly booker: BookingSeriesBooker,
    private readonly cancellation: BookingCancellationService,
  ) {}

  async preview(input: PreviewSeriesInput): Promise<SeriesPreview> {
    const ground = await this.activeGround(input.groundId);
    const horizon = await this.horizonOf(input);
    const dates = seriesDates(input.fromDate, horizon, input.weekdays);
    const plans = await this.booker.survey(this.prisma, ground.id, ground, input, dates, venueNow());
    const free = plans.filter((p) => p.reason === null);
    return {
      dates: plans.map((p) => ({
        date: p.date, slotId: p.slot?.id ?? null, price: p.slot?.price ?? null, available: p.reason === null,
        ...(p.reason !== null && { reason: p.reason }),
      })),
      bookableCount: free.length,
      total: free.reduce((sum, p) => sum + p.slot!.price, 0),
      horizon,
    };
  }

  /**
   * Creates the series and books every free matching date in one transaction (confirmed, no emails);
   * nothing free → 409 NOTHING_TO_BOOK and nothing is saved. A payment is spread over the bookings,
   * earliest first.
   */
  async create(actorId: string, input: CreateSeriesInput): Promise<SeriesDto> {
    const ground = await this.activeGround(input.groundId);
    if (input.customer.id && !(await this.prisma.customer.findFirst({ where: { id: input.customer.id, deletedAt: null } }))) {
      throw new AppError('Customer not found', 404, 'CUSTOMER_NOT_FOUND');
    }
    const horizon = await this.horizonOf(input);
    const dates = seriesDates(input.fromDate, horizon, input.weekdays);

    const id = await withBookingNumber(() => withUniqueReference(() => this.prisma.$transaction(async (tx) => {
      const series = await this.createSeries(tx, actorId, input, horizon);
      const booked = await this.booker.book(tx, series, ground, dates, actorId, venueNow());
      if (booked.length === 0) throw nothingToBook();
      await this.payOnCreate(tx, booked, input.payment, actorId);
      return series.id;
    }, SERIES_TX)));
    return this.get(id);
  }

  async get(id: string): Promise<SeriesDto> {
    const series = await this.prisma.bookingSeries.findFirst({ where: { id, deletedAt: null }, include: SERIES_INCLUDE });
    if (!series) throw seriesNotFound();
    return toSeriesDto(series);
  }

  /** Collects money over the live bookings with something due (one month's, or all), earliest first. */
  async recordPayment(actorId: string, id: string, input: SeriesPaymentRecordInput): Promise<SeriesDto> {
    await this.get(id);
    await withUniqueReference(() => this.prisma.$transaction(async (tx) => {
      // Touch the series first: two collections at once queue here, so each reads the other's payments.
      await tx.bookingSeries.update({ where: { id }, data: { updatedAt: new Date() } });
      const bookings = await tx.booking.findMany({
        where: { seriesId: id, deletedAt: null, status: { notIn: ['cancelled', 'no_show'] }, ...(input.month && monthWhere(input.month)) },
        orderBy: { slot: { date: 'asc' } },
        include: { payments: { where: { deletedAt: null } } },
      });
      if (bookings.some((b) => pendingWalletPayment(b.payments))) throw paymentUnderReview();
      const owing = bookings.filter((b) => dueOf(b, b.payments) > 0);
      const due = owing.reduce((sum, b) => sum + dueOf(b, b.payments), 0);
      if (input.amount > due) throw amountExceedsDue(due);
      await recordAllocated(tx, owing, input, actorId);
    }));
    return this.get(id);
  }

  /**
   * Turns the series off and cancels its bookings from `fromDate` on that haven't started (refunded
   * if asked, no emails). Earlier bookings stay. One that can't be cancelled is logged and left as it is.
   */
  async stop(actorId: string, id: string, { fromDate, refund, reason }: StopSeriesInput): Promise<SeriesDto> {
    await this.get(id);
    const { count } = await this.prisma.bookingSeries.updateMany({
      where: { id, status: 'active' }, data: { status: 'stopped', stoppedAt: new Date(), stoppedById: actorId },
    });
    if (count === 0) throw seriesStopped();
    const now = venueNow();
    const bookings = await this.prisma.booking.findMany({
      where: { seriesId: id, deletedAt: null, status: { in: ['pending', 'confirmed'] }, slot: { date: { gte: toDbDate(fromDate) } } },
      include: { slot: { select: { date: true, startHour: true, startMinute: true } } },
    });
    for (const b of bookings.filter((x) => !hasStarted(now, fromDbDate(x.slot.date), slotHour(x.slot)))) {
      try {
        await this.cancellation.cancel(b.id, { actorId, reason: reason ?? 'Repeat booking stopped', refund, notify: false });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        this.logger.warn(`Repeat booking ${id}: booking ${b.id} not cancelled (${err.code ?? err.message})`);
      }
    }
    return this.get(id);
  }

  private async createSeries(tx: Prisma.TransactionClient, actorId: string, input: CreateSeriesInput, horizon: IsoDate) {
    const { id, ...contact } = input.customer;
    const customerId = id ?? await upsertCustomerByPhone(tx, contact, true);
    const contactEmail = await contactEmailOf(tx, customerId, contact.email);
    return tx.bookingSeries.create({
      data: {
        groundId: input.groundId, customerId, contactName: contact.name, contactPhone: contact.phone, contactEmail,
        startHour: input.startHour, startMinute: input.startMinute, weekdays: input.weekdays, fromDate: toDbDate(input.fromDate),
        untilDate: input.untilDate ? toDbDate(input.untilDate) : null, bookedThrough: toDbDate(horizon),
        notes: input.notes ?? null, createdById: actorId,
      },
    });
  }

  /** `full` = the total of the bookings made; `partial` must be less than that. */
  private async payOnCreate(tx: Prisma.TransactionClient, booked: BookedDate[], payment: CreateSeriesInput['payment'], actorId: string) {
    if (payment.type === 'none') return;
    const total = booked.reduce((sum, b) => sum + b.total, 0);
    if (payment.type === 'partial' && payment.amount! >= total) {
      throw exceedsDue('An advance must be less than the total; record it as a full payment');
    }
    const bookings = booked.map((b) => ({ id: b.id, status: 'confirmed' as const, total: b.total, payments: [] }));
    const amount = payment.type === 'full' ? total : payment.amount!;
    await recordAllocated(tx, bookings, { amount, method: payment.method!, reference: payment.reference }, actorId);
  }

  /** Fixed: untilDate. Ongoing: the ground's latest slot (fromDate when it has none from then on). */
  private async horizonOf({ groundId, fromDate, untilDate }: PreviewSeriesInput): Promise<IsoDate> {
    if (untilDate) return untilDate;
    const last = await lastSlotDate(this.prisma, groundId);
    return last && last > fromDate ? last : fromDate;
  }

  private async activeGround(id: string): Promise<Ground> {
    const ground = await this.prisma.ground.findUnique({ where: { id } });
    if (!ground || !ground.isActive) throw groundNotFound();
    return ground;
  }
}

const monthWhere = (month: string): Prisma.BookingWhereInput => {
  const { from, to } = monthRange(month);
  return { slot: { date: { gte: toDbDate(from), lte: toDbDate(to) } } };
};
