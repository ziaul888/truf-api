import type { PrismaService } from '../prisma/prisma.service.js';
import { fromDbDate, hasStarted, type IsoDate, type VenueNow } from '../slots/venue-time.js';
import { CARD_CHECKOUT_IN_PROGRESS, dueOf, WALLET_UNDER_REVIEW } from './booking-rules.js';

export const DUE_FILTERS = ['overdue', 'today', 'any'] as const;
export type DueFilter = (typeof DUE_FILTERS)[number];

export interface OwingBooking {
  id: string;
  bookingNumber: string;
  customerName: string;
  due: number;
  dueDate: IsoDate | null;
  date: IsoDate;
  startHour: number;
  /** Part of a repeat booking: paid per month whenever the customer pays, so never overdue without a due date. */
  inSeries: boolean;
}

/**
 * Live bookings with money still due. Completed ones count too: a slot that's been played and not
 * paid for is exactly what "overdue" is for. Card checkouts still in Stripe and bKash / Nagad
 * payments still being verified are left out.
 */
export async function loadOwing(prisma: PrismaService): Promise<OwingBooking[]> {
  const rows = await prisma.booking.findMany({
    where: {
      deletedAt: null, status: { in: ['pending', 'confirmed', 'completed'] }, paymentStatus: { notIn: ['paid', 'refunded'] },
      NOT: [CARD_CHECKOUT_IN_PROGRESS, WALLET_UNDER_REVIEW],
    },
    select: {
      id: true, bookingNumber: true, contactName: true, status: true, total: true, dueDate: true, seriesId: true, slot: { select: { date: true, startHour: true } },
      payments: { where: { deletedAt: null }, select: { amount: true, status: true } },
    },
  });
  return rows
    .map((b) => ({
      id: b.id, bookingNumber: b.bookingNumber, customerName: b.contactName, due: dueOf(b, b.payments), dueDate: b.dueDate ? fromDbDate(b.dueDate) : null,
      date: fromDbDate(b.slot.date), startHour: b.slot.startHour, inSeries: b.seriesId !== null,
    }))
    .filter((b) => b.due > 0);
}

/** Past its due date; with no due date, once the slot has started (except repeat bookings, which have no deadline). */
export const isOverdue = (b: OwingBooking, now: VenueNow) =>
  (b.dueDate ? b.dueDate < now.date : !b.inSeries && hasStarted(now, b.date, b.startHour));

export const isDueToday = (b: OwingBooking, now: VenueNow) => b.dueDate === now.date;

export const matchesDue = (b: OwingBooking, filter: DueFilter, now: VenueNow) =>
  filter === 'any' || (filter === 'overdue' ? isOverdue(b, now) : isDueToday(b, now));
