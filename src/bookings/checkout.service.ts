import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { env } from '../config/env.js';
import { contactEmailOf, upsertCustomerByPhone } from '../customers/customer-upsert.js';
import type { Ground, Slot } from '../generated/prisma/client.js';
import { VISIBLE_GROUND } from '../grounds/ground-rules.js';
import { cardPaymentsEnabled, StripeService } from '../payments/stripe.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SlotSettingsService } from '../slots/slot-settings.service.js';
import { assertDayOpen, groundNotFound, slotInPast } from '../slots/slot-rules.js';
import type { SlotSettings } from '../slots/slots.schemas.js';
import { addDays, hasStarted, minutesUntil, toDbDate, venueNow } from '../slots/venue-time.js';
import { BookingCancellationService } from './booking-cancellation.service.js';
import { BookingNotifier } from './booking-notifier.service.js';
import { BOOKING_INCLUDE, customerCanPay } from './booking.dto.js';
import {
  bookingNotFound, bookingNotPending, dueOf, bookingToken, confirmationUrl, isUnderReview, isValidBookingToken, isWalletMethod, methodName,
  paymentUnderReview, slotNotAvailable, withBookingNumber, type WalletMethod,
} from './booking-rules.js';
import type { CheckoutInput } from './bookings.schemas.js';
import { assertCanBookUnpaid } from './checkout-limits.js';

export interface CheckoutResult {
  bookingId: string;
  paymentMethod: CheckoutInput['paymentMethod'];
  /** Card: send the customer here (Stripe). Null for cash, bKash and Nagad. */
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
  cardEnabled: boolean;
  cashEnabled: boolean;
  /** bKash / Nagad numbers the customer can send money to; only those the admin has set. */
  wallets: { method: WalletMethod; number: string }[];
  serviceFee: number;
  currency: string;
  holdMinutes: number;
}

const outsideWindow = (message: string) => new AppError(message, 400, 'OUTSIDE_BOOKING_WINDOW');
const emailRequired = () =>
  new AppError('Enter your email: your booking link is sent there. Or sign in with your phone', 400, 'EMAIL_REQUIRED');

/**
 * Portal checkout.
 * - Card: holds the slot (status `held`) for `holdMinutes` and creates a pending booking in one
 *   transaction, then opens a Stripe Checkout Session. The webhook confirms it; the hold sweep
 *   releases it if the customer doesn't pay.
 * - Cash ("pay at the venue"): books the slot and creates a pending, unpaid booking that waits
 *   in the staff review queue. Off when the `portalCashEnabled` setting is.
 * - bKash / Nagad: the customer has sent the total to the venue's number and gives the TrxID.
 *   Books the slot like cash, with a pending payment that staff verify in their own app. Off
 *   while the admin hasn't set that number.
 * - Cash, bKash and Nagad need a signed-in customer and are capped per phone (`checkout-limits.ts`).
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
    const settings = await this.settings.get();
    const { portalCashEnabled, serviceFee, holdMinutes } = settings;
    const wallets = (['bkash', 'nagad'] as const).flatMap((method) => {
      const number = walletNumberOf(settings, method);
      return number ? [{ method, number }] : [];
    });
    return { cardEnabled: cardPaymentsEnabled(), cashEnabled: portalCashEnabled, wallets, serviceFee, currency: env.CURRENCY, holdMinutes };
  }

  /**
   * `verifiedPhone`: the signed-in customer's number. The booking goes on it, and the name and
   * email given update their record (a guest checkout never changes a customer record). The email
   * is optional only when signed in (blank: their stored one, else none); a guest card checkout
   * needs one, as the booking link only reaches them by email (`400 EMAIL_REQUIRED`).
   */
  async start(body: CheckoutInput, verifiedPhone?: string): Promise<CheckoutResult> {
    const input = verifiedPhone ? { ...body, customerPhone: verifiedPhone } : body;
    const settings = await this.settings.get();
    assertMethodAvailable(input.paymentMethod, settings);
    await assertCanBookUnpaid(this.prisma, input.paymentMethod, verifiedPhone);
    if (!verifiedPhone && !input.customerEmail) throw emailRequired();
    const ground = await this.prisma.ground.findFirst({ where: { id: input.groundId, ...VISIBLE_GROUND } });
    if (!ground) throw groundNotFound();
    const slot = await this.prisma.slot.findUnique({
      where: { groundId_date_startHour: { groundId: ground.id, date: toDbDate(input.date), startHour: input.startHour } },
    });
    if (!slot) throw slotNotAvailable();
    assertBookable(slot, input.date, settings);
    assertDayOpen(ground, input.date);

    const bookingId = await this.reserve(input, ground, slot, settings, Boolean(verifiedPhone));
    if (input.paymentMethod !== 'card') {
      await this.notifier.received(bookingId);
      await this.notifier.newBookingToAdmins(bookingId);
      return { bookingId, paymentMethod: input.paymentMethod, checkoutUrl: null, confirmationUrl: confirmationUrl(bookingId) };
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
    assertCardAvailable();
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
    assertCardAvailable();
    if (!isValidBookingToken(bookingId, token)) throw bookingNotFound();
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, deletedAt: null }, include: BOOKING_INCLUDE });
    if (!booking) throw bookingNotFound();
    if (isUnderReview(booking, booking.payments)) throw paymentUnderReview('The venue is still verifying your payment');
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
   * card payment is under way, or straight to `booked` for pay-at-venue, bKash and Nagad. A TrxID
   * already used rolls the whole booking back (409 REFERENCE_ALREADY_USED).
   */
  private reserve(input: CheckoutInput, ground: Ground, slot: Slot, settings: SlotSettings, verified: boolean): Promise<string> {
    const bookingId = randomUUID();
    const total = slot.price + settings.serviceFee;
    const slotData = input.paymentMethod !== 'card'
      ? { status: 'booked' as const }
      : { status: 'held' as const, heldUntil: new Date(Date.now() + settings.holdMinutes * 60_000), heldByBookingId: bookingId };
    return withBookingNumber((bookingNumber) => this.prisma.$transaction(async (tx) => {
      const { count } = await tx.slot.updateMany({ where: { id: slot.id, status: 'available' }, data: slotData });
      if (count === 0) throw slotNotAvailable();
      const contact = { name: input.customerName, email: input.customerEmail, phone: input.customerPhone };
      const customerId = await upsertCustomerByPhone(tx, contact, verified);
      const contactEmail = await contactEmailOf(tx, customerId, contact.email);
      await tx.booking.create({
        data: {
          id: bookingId, bookingNumber, source: 'portal', groundId: ground.id, slotId: slot.id, liveSlotId: slot.id,
          customerId, contactName: contact.name, contactEmail, contactPhone: contact.phone,
          amount: slot.price, serviceFee: settings.serviceFee, total, payAtVenue: input.paymentMethod === 'cash',
          payments: walletPaymentOf(input, total),
          events: { create: { type: 'created', detail: createdDetail(input) } },
        },
      });
      return bookingId;
    }));
  }
}

const walletNumberOf = (settings: SlotSettings, method: WalletMethod) => (method === 'bkash' ? settings.bkashNumber : settings.nagadNumber);

function assertCardAvailable() {
  if (!cardPaymentsEnabled()) throw new AppError('Card payment is not available right now', 400, 'CARD_NOT_AVAILABLE');
}

/** Each payment method only while it's switched on (card: Stripe keys; cash: setting; wallets: number set). */
function assertMethodAvailable(method: CheckoutInput['paymentMethod'], settings: SlotSettings) {
  if (method === 'card') assertCardAvailable();
  if (method === 'cash' && !settings.portalCashEnabled) {
    throw new AppError('Paying at the venue is not available right now. Please pay by card', 400, 'CASH_NOT_AVAILABLE');
  }
  if (isWalletMethod(method) && !walletNumberOf(settings, method)) {
    throw new AppError(`${methodName(method)} payment is not available right now`, 400, 'WALLET_NOT_AVAILABLE');
  }
}

/** bKash / Nagad: the money the customer says they sent, pending until staff verify it. */
function walletPaymentOf(input: CheckoutInput, total: number) {
  if (!isWalletMethod(input.paymentMethod)) return undefined;
  return {
    create: {
      method: input.paymentMethod, amount: total, currency: env.CURRENCY, status: 'pending' as const,
      reference: input.reference!, payerNumber: input.payerNumber!,
    },
  };
}

function createdDetail(input: CheckoutInput) {
  if (input.paymentMethod === 'cash') return 'Booked on the portal, paying cash at the venue';
  if (input.paymentMethod === 'card') return 'Checkout started on the portal';
  return `Booked on the portal, paid by ${methodName(input.paymentMethod)} (TrxID ${input.reference}), waiting for staff to verify`;
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
