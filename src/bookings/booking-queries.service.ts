import { Injectable } from '@nestjs/common';
import type { Paginated } from '../common/schemas.js';
import type { BookingStatus, Prisma } from '../generated/prisma/client.js';
import { StripeService } from '../payments/stripe.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SlotSettingsService } from '../slots/slot-settings.service.js';
import { upcomingWhere } from '../slots/slot-rules.js';
import { toDbDate, venueNow } from '../slots/venue-time.js';
import { BookingCancellationService } from './booking-cancellation.service.js';
import { BookingNotifier } from './booking-notifier.service.js';
import { loadOwing, matchesDue, type DueFilter } from './booking-due.js';
import { ABANDONED_CHECKOUT, bookingNotFound, confirmationUrl, isValidBookingToken } from './booking-rules.js';
import {
  BOOKING_DETAIL_INCLUDE, BOOKING_INCLUDE, customerCanCancel, customerCanPay, toBookingDetailDto, toBookingDto, toPublicBookingDto,
  type BookingDetailDto, type BookingDto, type PublicBookingDto,
} from './booking.dto.js';
import type { ListBookingsQuery, MyBookingsQuery } from './bookings.schemas.js';

/** A signed-in customer's booking, with its signed link for view / cancel / pay. */
export type MyBookingDto = PublicBookingDto & { confirmationUrl: string };

export type BookingCounts = Record<Exclude<BookingStatus, never>, number>;

/** Read side of bookings, for the dashboard and the customer's signed link. */
@Injectable()
export class BookingQueriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SlotSettingsService,
    private readonly cancellation: BookingCancellationService,
    private readonly stripe: StripeService,
    private readonly notifier: BookingNotifier,
  ) {}

  /** `counts` ignore the status filter, for the stat cards. */
  async list(q: ListBookingsQuery): Promise<Paginated<BookingDto> & { counts: BookingCounts }> {
    const base: Prisma.BookingWhereInput = { ...listWhere(q), ...(q.due && { id: { in: await this.owingIds(q.due) } }) };
    const where: Prisma.BookingWhereInput = { ...base, ...(q.status && { status: q.status }) };
    const orderBy: Prisma.BookingOrderByWithRelationInput[] = q.sort === 'slot'
      ? [{ slot: { date: 'asc' } }, { slot: { startHour: 'asc' } }]
      : [{ createdAt: 'desc' }];
    const [rows, total, groups] = await this.prisma.$transaction([
      this.prisma.booking.findMany({ where, include: BOOKING_INCLUDE, orderBy, skip: (q.page - 1) * q.limit, take: q.limit }),
      this.prisma.booking.count({ where }),
      this.prisma.booking.groupBy({ by: ['status'], where: base, orderBy: { status: 'asc' }, _count: { _all: true } }),
    ]);
    const counts: BookingCounts = { pending: 0, confirmed: 0, cancelled: 0, completed: 0 };
    for (const g of groups) counts[g.status] = (g._count as { _all: number })._all;
    return { data: rows.map(toBookingDto), total, page: q.page, limit: q.limit, counts };
  }

  private async owingIds(filter: DueFilter): Promise<string[]> {
    const now = venueNow();
    return (await loadOwing(this.prisma)).filter((b) => matchesDue(b, filter, now)).map((b) => b.id);
  }

  async get(id: string): Promise<BookingDetailDto> {
    const booking = await this.prisma.booking.findFirst({ where: { id, deletedAt: null }, include: BOOKING_DETAIL_INCLUDE });
    if (!booking) throw bookingNotFound();
    const totalBookings = await this.prisma.booking.count({
      where: { customerId: booking.customerId, deletedAt: null, status: { not: 'cancelled' } },
    });
    return toBookingDetailDto(booking, totalBookings);
  }

  /** The next pending or confirmed bookings from now (dashboard home). */
  async upcoming(limit: number): Promise<BookingDto[]> {
    const rows = await this.prisma.booking.findMany({
      where: { deletedAt: null, status: { in: ['pending', 'confirmed'] }, slot: upcomingWhere(venueNow()) },
      include: BOOKING_INCLUDE,
      orderBy: [{ slot: { date: 'asc' } }, { slot: { startHour: 'asc' } }],
      take: limit,
    });
    return rows.map(toBookingDto);
  }

  /** Every booking made with the signed-in customer's phone, guest and staff bookings included. */
  async listMine(phone: string, q: MyBookingsQuery): Promise<Paginated<MyBookingDto>> {
    const now = venueNow();
    const upcoming: Prisma.BookingWhereInput = { status: { in: ['pending', 'confirmed'] }, slot: upcomingWhere(now) };
    const where: Prisma.BookingWhereInput = {
      deletedAt: null, customer: { phone },
      ...(q.scope === 'upcoming' ? { ...upcoming, NOT: ABANDONED_CHECKOUT } : { NOT: [ABANDONED_CHECKOUT, upcoming] }),
    };
    const dir = q.scope === 'upcoming' ? 'asc' : 'desc';
    const [rows, total, { cancellationCutoffHours }] = await Promise.all([
      this.prisma.booking.findMany({
        where, include: BOOKING_INCLUDE, orderBy: [{ slot: { date: dir } }, { slot: { startHour: dir } }],
        skip: (q.page - 1) * q.limit, take: q.limit,
      }),
      this.prisma.booking.count({ where }),
      this.settings.get(),
    ]);
    const data = rows.map((b) => ({
      ...toPublicBookingDto(b, customerCanCancel(b, now, cancellationCutoffHours), customerCanPay(b)),
      confirmationUrl: confirmationUrl(b.id),
    }));
    return { data, total, page: q.page, limit: q.limit };
  }

  /** 404 without a valid token, so booking ids can't be guessed. */
  async getPublic(id: string, token: string | undefined): Promise<PublicBookingDto> {
    if (!isValidBookingToken(id, token)) throw bookingNotFound();
    const booking = await this.prisma.booking.findFirst({ where: { id, deletedAt: null }, include: BOOKING_INCLUDE });
    if (!booking) throw bookingNotFound();
    const { cancellationCutoffHours } = await this.settings.get();
    return toPublicBookingDto(booking, customerCanCancel(booking, venueNow(), cancellationCutoffHours), customerCanPay(booking));
  }

  /** Customer cancel through the signed link: full refund, slot freed, email sent. */
  async cancelPublic(id: string, token: string | undefined): Promise<PublicBookingDto> {
    if (!isValidBookingToken(id, token)) throw bookingNotFound();
    const booking = await this.prisma.booking.findUnique({ where: { id } });
    await this.cancellation.cancel(id, { actorId: null, refund: true, notify: true, byCustomer: true });
    await this.notifier.customerCancelledToStaff(id);
    if (booking?.status === 'pending' && booking.stripeCheckoutSessionId) {
      await this.stripe.expireSession(booking.stripeCheckoutSessionId);
    }
    return this.getPublic(id, token);
  }
}

function listWhere(q: ListBookingsQuery): Prisma.BookingWhereInput {
  const search = q.search;
  return {
    deletedAt: null,
    ...(q.paymentStatus && { paymentStatus: q.paymentStatus }),
    ...(q.groundId && { groundId: q.groundId }),
    ...(q.customerId && { customerId: q.customerId }),
    ...(q.from && q.to && { slot: { date: { gte: toDbDate(q.from), lte: toDbDate(q.to) } } }),
    ...(search && {
      OR: [
        { bookingNumber: { contains: search, mode: 'insensitive' } },
        { contactName: { contains: search, mode: 'insensitive' } },
        { contactPhone: { contains: search.replace(/[^\d+]/g, '') || search } },
        { customer: { name: { contains: search, mode: 'insensitive' } } },
      ],
    }),
  };
}
