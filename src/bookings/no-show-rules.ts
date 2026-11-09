import { AppError } from '../common/app-error.js';
import { fromDbDate, hasEnded, hasStarted, type VenueNow } from '../slots/venue-time.js';
import { bookingNotPending, isUnderReview } from './booking-rules.js';
import type { BookingRow } from './booking.dto.js';

type NoShowBooking = Pick<BookingRow, 'status' | 'source' | 'payAtVenue' | 'payments' | 'slot'>;

export const bookingNoShow = (message = 'This booking is marked no-show. Undo the no-show first') =>
  new AppError(message, 409, 'BOOKING_NO_SHOW');

/**
 * "Mark no-show" is open once the slot has started (venue time) on a pending, confirmed or completed
 * booking. A bKash / Nagad payment under review is verified or rejected first, and a portal card
 * checkout still in Stripe is left to finish or lapse (the same test as collecting a payment).
 */
export function assertCanMarkNoShow(b: NoShowBooking, now: VenueNow) {
  if (b.status === 'cancelled') throw new AppError('This booking is cancelled', 409, 'BOOKING_ALREADY_CANCELLED');
  if (b.status === 'no_show') throw new AppError('This booking is already marked no-show', 409, 'ALREADY_NO_SHOW');
  if (isUnderReview(b, b.payments)) {
    throw new AppError('This bKash / Nagad payment is not verified yet: verify or reject it first', 409, 'VERIFY_OR_REJECT');
  }
  if (b.status === 'pending' && b.source === 'portal' && !b.payAtVenue) {
    throw bookingNotPending('The customer is paying this booking by card. Wait for the card payment, or cancel it');
  }
  if (!hasStarted(now, fromDbDate(b.slot.date), b.slot.startHour)) {
    throw new AppError("This slot hasn't started yet, so the team can't be a no-show", 409, 'SLOT_NOT_STARTED');
  }
}

/** Undoing a no-show: completed once the slot has ended, confirmed before that (the hourly job completes it later). */
export const undoneStatusOf = (b: Pick<BookingRow, 'slot'>, now: VenueNow): 'completed' | 'confirmed' =>
  hasEnded(now, fromDbDate(b.slot.date), b.slot.startHour, b.slot.durationMinutes) ? 'completed' : 'confirmed';
