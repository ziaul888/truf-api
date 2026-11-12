import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { AppError } from '../common/app-error.js';
import { violatedUniqueIndex } from '../common/prisma-errors.js';
import { env } from '../config/env.js';
import type { BookingPaymentStatus, PaymentMethod, PaymentStatus, Prisma } from '../generated/prisma/client.js';

export const bookingNotFound = () => new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
export const slotNotAvailable = () => new AppError('That slot is no longer available. Pick another time', 409, 'SLOT_NOT_AVAILABLE');
export const bookingNotPending = (message = 'Only pending bookings can be confirmed') =>
  new AppError(message, 409, 'BOOKING_NOT_PENDING');
export const referenceAlreadyUsed = () =>
  new AppError('This transaction ID has already been used. Check the TrxID and try again', 409, 'REFERENCE_ALREADY_USED');
export const paymentUnderReview = (message = 'A bKash / Nagad payment on this booking is still being verified') =>
  new AppError(message, 409, 'PAYMENT_UNDER_REVIEW');
/** Two staff actions (or staff and the customer) hit the same booking at once; this one lost. */
export const bookingChanged = () =>
  new AppError('This booking changed meanwhile. Reload it and try again', 409, 'BOOKING_CHANGED');

/** Mobile wallets: the customer sends money to the venue's number, staff check it in their app. */
export const WALLET_METHODS = ['bkash', 'nagad'] as const satisfies readonly PaymentMethod[];
export type WalletMethod = (typeof WALLET_METHODS)[number];
export const isWalletMethod = (method: string): method is WalletMethod => (WALLET_METHODS as readonly string[]).includes(method);

const METHOD_NAMES: Record<PaymentMethod, string> = { card: 'card', cash: 'cash', bank_transfer: 'bank transfer', bkash: 'bKash', nagad: 'Nagad' };
/** For event details and emails ("Received 6000 by bKash"). */
export const methodName = (method: PaymentMethod) => METHOD_NAMES[method];

/** "Received 6000 by bKash (TrxID 9BC4D7XK2M)": the amount stays right after "Received" for the dashboard's label. */
export const receivedDetail = (amount: number, method: PaymentMethod, reference?: string | null) =>
  `Received ${amount} by ${methodName(method)}${reference ? ` (TrxID ${reference})` : ''}`;

/** Portal bookings paid by bKash / Nagad have a wallet payment from checkout; card checkouts never do. */
const NO_WALLET_PAYMENT: Prisma.BookingWhereInput = { payments: { none: { method: { in: [...WALLET_METHODS] } } } };

/**
 * Card checkouts that were never paid (the hold lapsed, the session expired, or the customer
 * walked away): left out of "My bookings" and every report.
 */
export const ABANDONED_CHECKOUT: Prisma.BookingWhereInput = {
  status: 'cancelled', source: 'portal', payAtVenue: false, confirmedAt: null, ...NO_WALLET_PAYMENT,
};

/**
 * A portal card checkout still in Stripe: paid or released within minutes, so never "to confirm" or "due".
 * bKash / Nagad bookings are not card checkouts: they wait for staff to verify the payment.
 */
export const CARD_CHECKOUT_IN_PROGRESS: Prisma.BookingWhereInput = { status: 'pending', source: 'portal', payAtVenue: false, ...NO_WALLET_PAYMENT };

/**
 * A portal booking whose bKash / Nagad payment staff haven't verified yet: "to verify", never money
 * owed (dues, overdue, reminders, customer due amounts).
 */
export const WALLET_UNDER_REVIEW: Prisma.BookingWhereInput = {
  status: 'pending', payments: { some: { status: 'pending', method: { in: [...WALLET_METHODS] }, deletedAt: null } },
};

const NUMBER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** e.g. "CT-24A7F": no 0/O or 1/I/L, so it can be read out over the phone. */
export const newBookingNumber = () =>
  `CT-${Array.from({ length: 5 }, () => NUMBER_ALPHABET[randomInt(NUMBER_ALPHABET.length)]).join('')}`;

const REFERENCE_INDEX = 'Payment_method_reference_key';

/**
 * Runs a booking write, retrying with a fresh number if the random booking number clashed.
 * A clash on a live-slot index (the booking's or a BookingSlot's) means a slot was taken: 409 SLOT_NOT_AVAILABLE; on a payment's
 * TrxID, 409 REFERENCE_ALREADY_USED.
 */
export async function withBookingNumber<T>(write: (bookingNumber: string) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write(newBookingNumber());
    } catch (err) {
      const index = violatedUniqueIndex(err);
      if (index === 'Booking_liveSlotId_key' || index === 'BookingSlot_liveSlotId_key') throw slotNotAvailable();
      if (index === REFERENCE_INDEX) throw referenceAlreadyUsed();
      if (index !== 'Booking_bookingNumber_key' || attempt >= 5) throw err;
    }
  }
}

/** Runs a payment write; a TrxID already recorded for that method is 409 REFERENCE_ALREADY_USED. */
export async function withUniqueReference<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (violatedUniqueIndex(err) === REFERENCE_INDEX) throw referenceAlreadyUsed();
    throw err;
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

/** The bKash / Nagad payment the customer sent at checkout, while staff have not verified it yet. */
export const pendingWalletPayment = <P extends PaymentLike & { method: PaymentMethod }>(payments: P[]) =>
  payments.find((p) => p.status === 'pending' && isWalletMethod(p.method));

/** Money received and not refunded. */
export const paidOf = (payments: PaymentLike[]) =>
  payments.filter((p) => p.status === 'succeeded').reduce((sum, p) => sum + p.amount, 0);

/** Still owed; nothing is owed on a cancelled booking, or on a no-show (the rest of the due is written off). */
export const dueOf = (booking: { status: string; total: number }, payments: PaymentLike[]) =>
  booking.status === 'cancelled' || booking.status === 'no_show' ? 0 : Math.max(booking.total - paidOf(payments), 0);

/** "No-show: 600 due written off: Didn't turn up". Amounts in the smallest unit, as every event detail. */
export const noShowDetail = (writtenOff: number, reason?: string | null) =>
  `No-show: ${writtenOff > 0 ? `${writtenOff} due written off` : 'no due written off'}${reason ? `: ${reason}` : ''}`;

/** Pending, with a bKash / Nagad payment waiting for staff to verify it. */
export const isUnderReview = (booking: { status: string }, payments: (PaymentLike & { method: PaymentMethod })[]) =>
  booking.status === 'pending' && pendingWalletPayment(payments) !== undefined;

/** Money owed, for dues and customer totals: nothing while a wallet payment is under review. */
export const owedOf = (booking: { status: string; total: number }, payments: (PaymentLike & { method: PaymentMethod })[]) =>
  (isUnderReview(booking, payments) ? 0 : dueOf(booking, payments));

export function paymentStatusOf(total: number, payments: PaymentLike[]): BookingPaymentStatus {
  const paid = paidOf(payments);
  if (paid >= total) return 'paid';
  if (paid > 0) return 'partial';
  if (payments.some((p) => p.status === 'refunded')) return 'refunded';
  if (payments.some((p) => p.status === 'failed')) return 'failed';
  return 'unpaid';
}
