import { ABANDONED_CHECKOUT } from '../bookings/booking-rules.js';
import type { BookingStatus, PaymentMethod, Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { fromDbDate, minutesUntil, toDbDate, venueNow, type IsoDate } from '../slots/venue-time.js';
import { instantsOf, percent, venueDateOf } from './report-periods.js';
import type { ReportRange } from './reports.schemas.js';

/** Money moving on a venue-local date: a payment received, or a refund made. */
export interface MoneyEvent {
  date: IsoDate;
  kind: 'received' | 'refund';
  amount: number;
  method: PaymentMethod;
  groundId: string;
}

export interface ReportBooking {
  date: IsoDate;
  status: BookingStatus;
  total: number;
  groundId: string;
  hours: number;
  /** The slot has finished. */
  ended: boolean;
}

export const METHODS: PaymentMethod[] = ['card', 'cash', 'bank_transfer'];

/** Bookings counted in reports: by slot date, without soft-deleted rows or abandoned card checkouts. */
export const reportBookingsWhere = (r: ReportRange): Prisma.BookingWhereInput => ({
  deletedAt: null, NOT: ABANDONED_CHECKOUT, slot: { date: { gte: toDbDate(r.from), lte: toDbDate(r.to) } },
});

/**
 * The dashboard's revenue rule: succeeded or refunded payments count when received, and each
 * refund counts against the day it was made (even if the payment came before the range).
 */
export async function loadMoney(prisma: PrismaService, r: ReportRange): Promise<MoneyEvent[]> {
  const span = instantsOf(r);
  const rows = await prisma.payment.findMany({
    where: {
      deletedAt: null,
      OR: [{ status: { in: ['succeeded', 'refunded'] }, createdAt: span }, { status: 'refunded', refundedAt: span }],
    },
    select: { amount: true, method: true, status: true, createdAt: true, refundedAt: true, booking: { select: { groundId: true } } },
  });
  const inSpan = (d: Date | null): d is Date => d !== null && d >= span.gte && d < span.lt;
  return rows.flatMap((p) => {
    const base = { amount: p.amount, method: p.method, groundId: p.booking.groundId };
    return [
      ...(inSpan(p.createdAt) ? [{ ...base, kind: 'received' as const, date: venueDateOf(p.createdAt) }] : []),
      ...(p.status === 'refunded' && inSpan(p.refundedAt) ? [{ ...base, kind: 'refund' as const, date: venueDateOf(p.refundedAt) }] : []),
    ];
  });
}

export async function loadBookings(prisma: PrismaService, r: ReportRange): Promise<ReportBooking[]> {
  const rows = await prisma.booking.findMany({
    where: reportBookingsWhere(r),
    select: { status: true, total: true, groundId: true, slot: { select: { date: true, startHour: true, durationMinutes: true } } },
  });
  const now = venueNow();
  return rows.map((b) => {
    const date = fromDbDate(b.slot.date);
    const hours = b.slot.durationMinutes / 60;
    return { date, status: b.status, total: b.total, groundId: b.groundId, hours, ended: minutesUntil(now, date, b.slot.startHour + hours) <= 0 };
  });
}

export interface MoneyTotals {
  received: number;
  refunds: number;
  revenue: number;
  /** Net of refunds. */
  byMethod: Record<PaymentMethod, number>;
}

export function moneyTotals(events: MoneyEvent[]): MoneyTotals {
  const totals: MoneyTotals = { received: 0, refunds: 0, revenue: 0, byMethod: { card: 0, cash: 0, bank_transfer: 0 } };
  for (const e of events) {
    const signed = e.kind === 'received' ? e.amount : -e.amount;
    if (e.kind === 'received') totals.received += e.amount;
    else totals.refunds += e.amount;
    totals.revenue += signed;
    totals.byMethod[e.method] += signed;
  }
  return totals;
}

export type StatusCounts = Record<BookingStatus, number>;

export const emptyStatusCounts = (): StatusCounts => ({ pending: 0, confirmed: 0, completed: 0, cancelled: 0 });

export function bookingTotals(bookings: ReportBooking[]) {
  const statusCounts = emptyStatusCounts();
  for (const b of bookings) statusCounts[b.status] += 1;
  const kept = bookings.filter((b) => b.status !== 'cancelled');
  const ended = bookings.filter((b) => b.ended);
  return {
    bookings: bookings.length,
    statusCounts,
    avgBookingValue: kept.length === 0 ? 0 : Math.round(kept.reduce((sum, b) => sum + b.total, 0) / kept.length),
    /** Of bookings whose slot has ended, the % completed rather than cancelled (or left pending). */
    completionRate: percent(ended.filter((b) => b.status === 'completed').length, ended.length),
    cancellationRate: percent(statusCounts.cancelled, bookings.length) ?? 0,
  };
}
