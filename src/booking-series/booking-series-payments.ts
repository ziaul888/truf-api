import { bookingChanged, dueOf, paymentStatusOf, receivedDetail } from '../bookings/booking-rules.js';
import { env } from '../config/env.js';
import type { BookingStatus, PaymentMethod, PaymentStatus, Prisma } from '../generated/prisma/client.js';
import { allocate } from './booking-series-rules.js';

/** A series booking that may take part of a payment, in date order. */
export interface PayableBooking {
  id: string;
  status: BookingStatus;
  total: number;
  payments: { amount: number; status: PaymentStatus }[];
}

export interface SeriesPayment {
  amount: number;
  method: PaymentMethod;
  reference?: string;
}

/**
 * Records one payment spread over several bookings, earliest first, each filled up to its due: a
 * Payment row and a `payment_received` event per booking, and its payment status recomputed.
 * The TrxID is unique per method, so it goes on the first row only; the others name it in their note.
 * Each booking is updated only from the status it was read in (409 BOOKING_CHANGED, rolled back).
 */
export async function recordAllocated(
  tx: Prisma.TransactionClient, bookings: PayableBooking[], payment: SeriesPayment, actorId: string,
): Promise<void> {
  const byId = new Map(bookings.map((b) => [b.id, b]));
  const parts = allocate(payment.amount, bookings.map((b) => ({ id: b.id, due: dueOf(b, b.payments) })));
  const split = parts.length > 1;
  for (const [i, part] of parts.entries()) {
    const booking = byId.get(part.id)!;
    const reference = i === 0 ? (payment.reference ?? null) : null;
    const note = split ? `Part of a ${payment.amount} repeat-booking payment${payment.reference ? ` (TrxID ${payment.reference})` : ''}` : null;
    await tx.payment.create({
      data: {
        bookingId: part.id, method: payment.method, amount: part.amount, currency: env.CURRENCY, status: 'succeeded',
        receivedAt: new Date(), reference, note, recordedById: actorId,
      },
    });
    await tx.bookingEvent.create({
      data: { bookingId: part.id, type: 'payment_received', userId: actorId, detail: receivedDetail(part.amount, payment.method, payment.reference) },
    });
    const paymentStatus = paymentStatusOf(booking.total, [...booking.payments, { amount: part.amount, status: 'succeeded' }]);
    const { count } = await tx.booking.updateMany({ where: { id: part.id, status: booking.status }, data: { paymentStatus } });
    if (count === 0) throw bookingChanged();
  }
}
