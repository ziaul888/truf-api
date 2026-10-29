import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { env } from '../config/env.js';
import { upsertCustomerByPhone } from '../customers/customer-upsert.js';
import type { Ground, Slot } from '../generated/prisma/client.js';
import { VISIBLE_GROUND } from '../grounds/ground-rules.js';
import { StripeService } from '../payments/stripe.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SlotSettingsService } from '../slots/slot-settings.service.js';
import { groundNotFound, slotInPast } from '../slots/slot-rules.js';
import type { SlotSettings } from '../slots/slots.schemas.js';
import { addDays, hasStarted, minutesUntil, toDbDate, venueNow } from '../slots/venue-time.js';
import { BookingCancellationService } from './booking-cancellation.service.js';
import { BookingNotifier } from './booking-notifier.service.js';
import { BOOKING_INCLUDE, customerCanPay } from './booking.dto.js';
import {
  bookingNotFound, bookingNotPending, dueOf, bookingToken, confirmationUrl, isValidBookingToken, slotNotAvailable, withBookingNumber,
} from './booking-rules.js';
import type { CheckoutInput } from './bookings.schemas.js';

export interface CheckoutResult {
  bookingId: string;
  paymentMethod: 'card' | 'cash';
  /** Card: send the customer here (Stripe). Null for cash. */
  checkoutUrl: string | null;
  /** The booking's signed link (the confirmation page). */
  confirmationUrl: string;
}

export interface DuePaymentResult extends CheckoutResult {
  /** What the customer is paying now (absent when resuming a card checkout). */
  amount?: number;
}

/** What the portal's checkout form needs to know. */
export interface CheckoutOptions {
  cashEnabled: boolean;
  serviceFee: number;
  currency: string;
  holdMinutes: number;
}

const outsideWindow = (message: string) => new AppError(message, 400, 'OUTSIDE_BOOKING_WINDOW');

/**
 * Portal checkout.
 * - Card: holds the slot (status `held`) for `holdMinutes` and creates a pending booking in one
 *   transaction, then opens a Stripe Checkout Session. The webhook confirms it; the hold sweep
 *   releases it if the customer doesn't pay.
 * - Cash ("pay at the venue"): books the slot and creates a pending, unpaid booking that waits
 *   in the staff review queue. Off when the `portalCashEnabled` setting is.
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly settings: SlotSettingsService,
    private readonly cancellation: BookingCancellationService,
    private readonly notifier: BookingNotifier,
  ) {}

  async options(): Promise<CheckoutOptions> {
    const { portalCashEnabled, serviceFee, holdMinutes } = await this.settings.get();
    return { cashEnabled: portalCashEnabled, serviceFee, currency: env.CURRENCY, holdMinutes };
  }

  /**
   * `verifiedPhone`: the signed-in customer's number. The booking goes on it, and the name and
   * email given update their record (a guest checkout never changes a customer record).
   */
  async start(body: CheckoutInput, verifiedPhone?: string): Promise<CheckoutResult> {
    const input = verifiedPhone ? { ...body, customerPhone: verifiedPhone } : body;
    const settings = await this.settings.get();
    if (input.paymentMethod === 'cash' && !settings.portalCashEnabled) {
      throw new AppError('Paying at the venue is not available right now. Please pay by card', 400, 'CASH_NOT_AVAILABLE');
    }
    const ground = await this.prisma.ground.findFirst({ where: { id: input.groundId, ...VISIBLE_GROUND } });
    if (!ground) throw groundNotFound();
    const slot = await this.prisma.slot.findUnique({
      where: { groundId_date_startHour: { groundId: ground.id, date: toDbDate(input.date), startHour: input.startHour } },
    });
    if (!slot) throw slotNotAvailable();
    assertBookable(slot, input.date, settings);

    const bookingId = await this.reserve(input, ground, slot, settings, Boolean(verifiedPhone));
    if (input.paymentMethod === 'cash') {
      await this.notifier.received(bookingId);
      await this.notifier.newBookingToAdmins(bookingId);
      return { bookingId, paymentMethod: 'cash', checkoutUrl: null, confirmationUrl: confirmationUrl(bookingId) };
    }
    try {
      const session = await this.stripe.createCheckoutSession({
        bookingId, total: slot.price + settings.serviceFee, customerEmail: input.customerEmail,
        description: `${ground.name}, ${input.date} ${String(input.startHour).padStart(2, '0')}:00`,
        successUrl: `${env.PUBLIC_APP_URL}/confirmation/${bookingId}?token=${bookingToken(bookingId)}`,
        cancelUrl: `${env.PUBLIC_APP_URL}/grounds/${ground.id}`,
      });
      await this.prisma.booking.update({ where: { id: bookingId }, data: { stripeCheckoutSessionId: session.id } });
      return { bookingId, paymentMethod: 'card', checkoutUrl: session.url, confirmationUrl: confirmationUrl(bookingId) };
    } catch (err) {
      // No way to pay: give the slot back straight away.
      await this.cancellation.cancel(bookingId, { actorId: null, reason: 'Payment could not be started', refund: false, notify: false });
      throw err;
    }
  }

  /** "Complete payment" on a pending booking: the open Stripe link while the hold lasts. */
  async resume(bookingId: string, token: string | undefined): Promise<CheckoutResult> {
    if (!isValidBookingToken(bookingId, token)) throw bookingNotFound();
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw bookingNotFound();
    const url = booking.status === 'pending' && booking.stripeCheckoutSessionId
      ? await this.stripe.openSessionUrl(booking.stripeCheckoutSessionId)
      : null;
    if (!url) throw bookingNotPending('This booking is no longer waiting for payment');
    return { bookingId, paymentMethod: 'card', checkoutUrl: url, confirmationUrl: confirmationUrl(bookingId) };
  }

  /**
   * "Pay now" on the customer's booking page: a Stripe Checkout Session for what's still due
   * (pay-at-venue, unpaid staff bookings, or the rest after an advance). The webhook records it.
   */
  async payDue(bookingId: string, token: string | undefined): Promise<DuePaymentResult> {
    if (!isValidBookingToken(bookingId, token)) throw bookingNotFound();
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, deletedAt: null }, include: BOOKING_INCLUDE });
    if (!booking) throw bookingNotFound();
    // A card checkout still in progress: hand back its open Stripe page.
    if (booking.source === 'portal' && !booking.payAtVenue && booking.status === 'pending') return this.resume(bookingId, token);
    if (!customerCanPay(booking)) throw new AppError('Nothing is due on this booking', 409, 'NOTHING_DUE');

    const due = dueOf(booking, booking.payments);
    const link = confirmationUrl(bookingId);
    const session = await this.stripe.createCheckoutSession({
      bookingId, purpose: 'due', total: due, customerEmail: booking.contactEmail,
      description: `Booking ${booking.bookingNumber}: ${booking.ground.name}`,
      successUrl: link, cancelUrl: link,
    });
    return { bookingId, paymentMethod: 'card', checkoutUrl: session.url, confirmationUrl: link, amount: due };
  }

  /**
   * The race-safe part: only one request can take the slot from available — to `held` while a
   * card payment is under way, or straight to `booked` for pay-at-venue.
   */
  private reserve(input: CheckoutInput, ground: Ground, slot: Slot, settings: SlotSettings, verified: boolean): Promise<string> {
    const bookingId = randomUUID();
    const cash = input.paymentMethod === 'cash';
    const slotData = cash
      ? { status: 'booked' as const }
      : { status: 'held' as const, heldUntil: new Date(Date.now() + settings.holdMinutes * 60_000), heldByBookingId: bookingId };
    return withBookingNumber((bookingNumber) => this.prisma.$transaction(async (tx) => {
      const { count } = await tx.slot.updateMany({ where: { id: slot.id, status: 'available' }, data: slotData });
      if (count === 0) throw slotNotAvailable();
      const contact = { name: input.customerName, email: input.customerEmail, phone: input.customerPhone };
      const customerId = await upsertCustomerByPhone(tx, contact, verified);
      await tx.booking.create({
        data: {
          id: bookingId, bookingNumber, source: 'portal', groundId: ground.id, slotId: slot.id, liveSlotId: slot.id,
          customerId, contactName: contact.name, contactEmail: contact.email, contactPhone: contact.phone,
          amount: slot.price, serviceFee: settings.serviceFee, total: slot.price + settings.serviceFee, payAtVenue: cash,
          events: { create: { type: 'created', detail: cash ? 'Booked on the portal, paying cash at the venue' : 'Checkout started on the portal' } },
        },
      });
      return bookingId;
    }));
  }
}

/** Customers can book only free slots, inside the booking window and outside the cutoff. */
function assertBookable(slot: Slot, date: string, settings: SlotSettings) {
  const now = venueNow();
  if (hasStarted(now, date, slot.startHour)) throw slotInPast();
  if (slot.status !== 'available') throw slotNotAvailable();
  if (date > addDays(now.date, settings.advanceBookingDays)) {
    throw outsideWindow(`Bookings open ${settings.advanceBookingDays} days ahead`);
  }
  if (minutesUntil(now, date, slot.startHour) <= settings.cancellationCutoffHours * 60) {
    throw outsideWindow(`Online bookings close ${settings.cancellationCutoffHours} hours before the start`);
  }
}
