import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { AppError } from '../common/app-error.js';
import { violatedUniqueIndex } from '../common/prisma-errors.js';
import { env } from '../config/env.js';
import type { BookingPaymentStatus, PaymentStatus } from '../generated/prisma/client.js';

export const bookingNotFound = () => new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
export const slotNotAvailable = () => new AppError('That slot is no longer available. Pick another time', 409, 'SLOT_NOT_AVAILABLE');
export const bookingNotPending = (message = 'Only pending bookings can be confirmed') =>
  new AppError(message, 409, 'BOOKING_NOT_PENDING');

const NUMBER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** e.g. "CT-24A7F": no 0/O or 1/I/L, so it can be read out over the phone. */
export const newBookingNumber = () =>
  `CT-${Array.from({ length: 5 }, () => NUMBER_ALPHABET[randomInt(NUMBER_ALPHABET.length)]).join('')}`;

/**
 * Runs a booking write, retrying with a fresh number if the random booking number clashed.
 * A clash on the live-slot index means the slot was taken: 409 SLOT_NOT_AVAILABLE.
 */
export async function withBookingNumber<T>(write: (bookingNumber: string) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write(newBookingNumber());
    } catch (err) {
      const index = violatedUniqueIndex(err);
      if (index === 'Booking_liveSlotId_key') throw slotNotAvailable();
      if (index !== 'Booking_bookingNumber_key' || attempt >= 5) throw err;
    }
  }
}

/** Signed-link token: whoever has it can view and cancel that one booking. Stateless (HMAC of the id). */
export const bookingToken = (bookingId: string) =>
  createHmac('sha256', env.JWT_SECRET).update(`booking:${bookingId}`).digest('base64url').slice(0, 32);

export function isValidBookingToken(bookingId: string, token: string | undefined): boolean {
  if (!token) return false;
  const expected = Buffer.from(bookingToken(bookingId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const confirmationUrl = (bookingId: string) =>
  `${env.PUBLIC_APP_URL}/confirmation/${bookingId}?token=${bookingToken(bookingId)}`;

interface PaymentLike {
  amount: number;
  status: PaymentStatus;
}

/** Money received and not refunded. */
export const paidOf = (payments: PaymentLike[]) =>
  payments.filter((p) => p.status === 'succeeded').reduce((sum, p) => sum + p.amount, 0);

/** Still owed; nothing is owed on a cancelled booking. */
export const dueOf = (booking: { status: string; total: number }, payments: PaymentLike[]) =>
  booking.status === 'cancelled' ? 0 : Math.max(booking.total - paidOf(payments), 0);

export function paymentStatusOf(total: number, payments: PaymentLike[]): BookingPaymentStatus {
  const paid = paidOf(payments);
  if (paid >= total) return 'paid';
  if (paid > 0) return 'partial';
  if (payments.some((p) => p.status === 'refunded')) return 'refunded';
  if (payments.some((p) => p.status === 'failed')) return 'failed';
  return 'unpaid';
}
