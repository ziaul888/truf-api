import { dueOf, paidOf } from '../bookings/booking-rules.js';
import type { Prisma } from '../generated/prisma/client.js';
import { fromDbDate, type IsoDate } from '../slots/venue-time.js';

export type CustomerTag = 'vip' | 'regular' | 'new';

/** 10+ bookings = VIP, 3–9 = Regular, otherwise New (as the dashboard shows). */
export const tagOf = (bookings: number): CustomerTag => (bookings >= 10 ? 'vip' : bookings >= 3 ? 'regular' : 'new');

/** The bookings data every customer summary is computed from. */
export const CUSTOMER_SUMMARY_INCLUDE = {
  bookings: {
    where: { deletedAt: null },
    select: {
      id: true, bookingNumber: true, status: true, total: true, dueDate: true,
      ground: { select: { id: true, name: true } },
      slot: { select: { date: true } },
      payments: { where: { deletedAt: null }, select: { amount: true, status: true } },
    },
  },
} satisfies Prisma.CustomerInclude;

export type CustomerSummaryRow = Prisma.CustomerGetPayload<{ include: typeof CUSTOMER_SUMMARY_INCLUDE }>;

export interface CustomerDto {
  id: string;
  name: string;
  phone: string | null;
  email: string;
  adminNote: string | null;
  /** Registration date. */
  createdAt: Date;
  /** Bookings that weren't cancelled. */
  bookings: number;
  totalSpent: number;
  lastBooking: IsoDate | null;
  dueAmount: number;
  tag: CustomerTag;
}

export function toCustomerDto(c: CustomerSummaryRow): CustomerDto {
  const kept = c.bookings.filter((b) => b.status !== 'cancelled');
  const dates = kept.map((b) => fromDbDate(b.slot.date)).sort();
  return {
    id: c.id, name: c.name, phone: c.phone, email: c.email, adminNote: c.adminNote, createdAt: c.createdAt,
    bookings: kept.length,
    totalSpent: c.bookings.reduce((sum, b) => sum + paidOf(b.payments), 0),
    lastBooking: dates.at(-1) ?? null,
    dueAmount: c.bookings.reduce((sum, b) => sum + dueOf(b, b.payments), 0),
    tag: tagOf(kept.length),
  };
}
