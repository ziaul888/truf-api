import { Injectable } from '@nestjs/common';
import { BOOKING_INCLUDE, toBookingDto, type BookingDto } from '../bookings/booking.dto.js';
import { dueOf } from '../bookings/booking-rules.js';
import { AppError } from '../common/app-error.js';
import { violatedUniqueIndex } from '../common/prisma-errors.js';
import type { Paginated } from '../common/schemas.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { upcomingWhere } from '../slots/slot-rules.js';
import { fromDbDate, venueDayStart, venueNow, type IsoDate } from '../slots/venue-time.js';
import { CUSTOMER_SUMMARY_INCLUDE, toCustomerDto, type CustomerDto } from './customer.dto.js';
import type { CreateCustomerInput, ListCustomersQuery, UpdateCustomerInput } from './customers.schemas.js';

export interface CustomerStats {
  total: number;
  newThisMonth: number;
  withDuePayments: number;
  totalDueAmount: number;
  totalRevenue: number;
}

export interface CustomerDetailDto extends CustomerDto {
  /** Latest 20, newest slot first. */
  recentBookings: BookingDto[];
  duePayments: { bookingId: string; bookingNumber: string; amount: number; dueDate: IsoDate | null }[];
  favoriteGround: { id: string; name: string; bookings: number } | null;
}

const notFound = () => new AppError('Customer not found', 404, 'CUSTOMER_NOT_FOUND');
const phoneTaken = () => new AppError('A customer with this phone number already exists', 409, 'CUSTOMER_PHONE_TAKEN');

type SortKey = ListCustomersQuery['sort'];
const SORTS: Record<SortKey, (c: CustomerDto) => number | string> = {
  lastBooking: (c) => c.lastBooking ?? '',
  totalSpent: (c) => c.totalSpent,
  bookings: (c) => c.bookings,
  since: (c) => c.createdAt.toISOString(),
  due: (c) => c.dueAmount,
};

/**
 * Customers with totals computed from their bookings. Filtering and sorting on those totals
 * happens in memory: fine for one venue's customer list in v1.
 */
@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async list({ page, limit, search, tag, hasDue, sort }: ListCustomersQuery): Promise<Paginated<CustomerDto> & { stats: CustomerStats }> {
    const rows = await this.prisma.customer.findMany({ where: { deletedAt: null }, include: CUSTOMER_SUMMARY_INCLUDE });
    const all = rows.map(toCustomerDto);
    const term = search?.toLowerCase();
    const matches = all
      .filter((c) => !term || [c.name, c.email, c.phone ?? ''].some((v) => v.toLowerCase().includes(term)))
      .filter((c) => !tag || c.tag === tag)
      .filter((c) => hasDue === undefined || (c.dueAmount > 0) === hasDue)
      .sort((a, b) => (SORTS[sort](a) < SORTS[sort](b) ? 1 : SORTS[sort](a) > SORTS[sort](b) ? -1 : 0));
    return {
      data: matches.slice((page - 1) * limit, page * limit), total: matches.length, page, limit,
      stats: this.stats(all),
    };
  }

  async get(id: string): Promise<CustomerDetailDto> {
    const row = await this.prisma.customer.findFirst({ where: { id, deletedAt: null }, include: CUSTOMER_SUMMARY_INCLUDE });
    if (!row) throw notFound();
    const recent = await this.prisma.booking.findMany({
      where: { customerId: id, deletedAt: null }, include: BOOKING_INCLUDE,
      orderBy: [{ slot: { date: 'desc' } }, { slot: { startHour: 'desc' } }], take: 20,
    });
    const owing = row.bookings.filter((b) => dueOf(b, b.payments) > 0);
    return {
      ...toCustomerDto(row),
      recentBookings: recent.map(toBookingDto),
      duePayments: owing.map((b) => ({
        bookingId: b.id, bookingNumber: b.bookingNumber, amount: dueOf(b, b.payments), dueDate: b.dueDate ? fromDbDate(b.dueDate) : null,
      })),
      favoriteGround: favoriteGround(row.bookings.filter((b) => b.status !== 'cancelled')),
    };
  }

  /** Exact match on the normalised phone; fills the New Booking form. */
  async findByPhone(phone: string) {
    return this.prisma.customer.findFirst({
      where: { phone, deletedAt: null }, select: { id: true, name: true, phone: true, email: true },
    });
  }

  async create(input: CreateCustomerInput): Promise<CustomerDto> {
    const existing = await this.prisma.customer.findUnique({ where: { phone: input.phone } });
    if (existing && !existing.deletedAt) throw phoneTaken();
    // A deleted customer with this phone comes back with the new details.
    const data = { name: input.name, email: input.email, phone: input.phone, adminNote: input.adminNote ?? null, deletedAt: null };
    const row = await this.write(() => existing
      ? this.prisma.customer.update({ where: { id: existing.id }, data, include: CUSTOMER_SUMMARY_INCLUDE })
      : this.prisma.customer.create({ data, include: CUSTOMER_SUMMARY_INCLUDE }));
    return toCustomerDto(row);
  }

  async update(id: string, input: UpdateCustomerInput): Promise<CustomerDto> {
    await this.findOrThrow(id);
    const row = await this.write(() => this.prisma.customer.update({ where: { id }, data: input, include: CUSTOMER_SUMMARY_INCLUDE }));
    return toCustomerDto(row);
  }

  /** Soft delete. Refused while the customer has an upcoming booking. */
  async remove(id: string): Promise<{ deleted: true }> {
    await this.findOrThrow(id);
    const upcoming = await this.prisma.booking.count({
      where: { customerId: id, deletedAt: null, status: { in: ['pending', 'confirmed'] }, slot: upcomingWhere(venueNow()) },
    });
    if (upcoming > 0) {
      throw new AppError('This customer has upcoming bookings. Cancel them first', 409, 'CUSTOMER_HAS_UPCOMING_BOOKINGS');
    }
    await this.prisma.customer.update({ where: { id }, data: { deletedAt: new Date() } });
    return { deleted: true };
  }

  private stats(all: CustomerDto[]): CustomerStats {
    const monthStart = venueDayStart(`${venueNow().date.slice(0, 7)}-01`);
    return {
      total: all.length,
      newThisMonth: all.filter((c) => c.createdAt >= monthStart).length,
      withDuePayments: all.filter((c) => c.dueAmount > 0).length,
      totalDueAmount: all.reduce((sum, c) => sum + c.dueAmount, 0),
      totalRevenue: all.reduce((sum, c) => sum + c.totalSpent, 0),
    };
  }

  private async findOrThrow(id: string) {
    const customer = await this.prisma.customer.findFirst({ where: { id, deletedAt: null } });
    if (!customer) throw notFound();
    return customer;
  }

  private async write<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (violatedUniqueIndex(err) === 'Customer_phone_key') throw phoneTaken();
      throw err;
    }
  }
}

function favoriteGround(bookings: { ground: { id: string; name: string } }[]) {
  const counts = new Map<string, { id: string; name: string; bookings: number }>();
  for (const { ground } of bookings) {
    const entry = counts.get(ground.id) ?? { ...ground, bookings: 0 };
    entry.bookings++;
    counts.set(ground.id, entry);
  }
  return [...counts.values()].sort((a, b) => b.bookings - a.bookings)[0] ?? null;
}
