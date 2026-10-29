import { Injectable } from '@nestjs/common';
import type Stripe from 'stripe';
import { violatedUniqueIndex } from '../common/prisma-errors.js';
import { env } from '../config/env.js';
import type { Booking } from '../generated/prisma/client.js';
import { StripeService } from '../payments/stripe.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BookingCancellationService } from './booking-cancellation.service.js';
import { BookingNotifier } from './booking-notifier.service.js';
import { dueOf, paymentStatusOf } from './booking-rules.js';

const idOf = (value: string | { id: string } | null | undefined) => (typeof value === 'string' ? value : value?.id);

/**
 * Stripe events. Every handler is idempotent: Stripe may deliver an event more than once.
 * Throwing makes the endpoint fail, so Stripe retries later (e.g. when a refund fails).
 */
@Injectable()
export class StripeWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly cancellation: BookingCancellationService,
    private readonly notifier: BookingNotifier,
  ) {}

  async handle(rawBody: Buffer, signature: string | undefined): Promise<{ received: true }> {
    const event = this.stripe.parseWebhook(rawBody, signature);
    switch (event.type) {
      case 'checkout.session.completed': await this.paid(event.data.object); break;
      case 'checkout.session.expired': await this.expired(event.data.object); break;
      case 'payment_intent.payment_failed': await this.failed(event.data.object); break;
      case 'charge.refunded': await this.refundedInStripe(event.data.object); break;
      default: break;
    }
    return { received: true };
  }

  private async paid(session: Stripe.Checkout.Session) {
    const bookingId = session.metadata?.bookingId;
    const intentId = idOf(session.payment_intent);
    if (!bookingId || !intentId || session.payment_status !== 'paid') return;
    if (await this.prisma.payment.findUnique({ where: { stripePaymentIntentId: intentId } })) return;
    if (session.metadata?.purpose === 'due') return this.duePaid(bookingId, intentId, session.amount_total ?? 0);
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) return;

    const amount = session.amount_total ?? booking.total;
    const cardLast4 = await this.stripe.cardLast4(intentId);
    if (await this.confirm(booking, intentId, amount, cardLast4)) {
      await this.notifier.confirmed(booking.id);
      await this.notifier.newBookingToAdmins(booking.id);
    } else {
      await this.refundLatePayment(booking, intentId, amount, cardLast4);
    }
  }

  /** Books the slot if this booking still holds it, or it's free again after the hold lapsed. */
  private async confirm(booking: Booking, intentId: string, amount: number, cardLast4: string | null): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.slot.updateMany({
          where: { id: booking.slotId, OR: [{ status: 'held', heldByBookingId: booking.id }, { status: 'available' }] },
          data: { status: 'booked', heldUntil: null, heldByBookingId: null },
        });
        if (count === 0) return false;
        await tx.payment.create({
          data: { bookingId: booking.id, method: 'card', stripePaymentIntentId: intentId, cardLast4, amount, currency: env.CURRENCY, status: 'succeeded' },
        });
        await tx.booking.update({
          where: { id: booking.id },
          data: {
            status: 'confirmed', paymentStatus: 'paid', confirmedAt: new Date(), liveSlotId: booking.slotId,
            cancelledAt: null, cancelReason: null, cancelledById: null,
          },
        });
        await tx.bookingEvent.createMany({
          data: [
            { bookingId: booking.id, type: 'payment_received', detail: `Paid ${amount} by card` },
            { bookingId: booking.id, type: 'confirmed', detail: booking.status === 'cancelled' ? 'Paid after the hold lapsed; slot was still free' : 'Confirmed by payment' },
          ],
        });
        return true;
      });
    } catch (err) {
      if (violatedUniqueIndex(err) === 'Booking_liveSlotId_key') return false;
      throw err;
    }
  }

  /** Paid, but someone else has the slot now: refund in full and tell the customer. */
  private async refundLatePayment(booking: Booking, intentId: string, amount: number, cardLast4: string | null) {
    const stripeRefundId = await this.stripe.refund(intentId);
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          bookingId: booking.id, method: 'card', stripePaymentIntentId: intentId, cardLast4, amount, currency: env.CURRENCY,
          status: 'refunded', stripeRefundId, refundedAt: new Date(),
        },
      });
      await tx.booking.update({ where: { id: booking.id }, data: { status: 'cancelled', paymentStatus: 'refunded', liveSlotId: null } });
      await tx.bookingEvent.createMany({
        data: [
          { bookingId: booking.id, type: 'payment_received', detail: `Paid ${amount} by card after the hold lapsed` },
          { bookingId: booking.id, type: 'refunded', detail: `Refunded ${amount}: the slot was taken meanwhile` },
        ],
      });
    });
    await this.notifier.cancelled(booking.id, {
      reason: 'The slot was taken by someone else while your payment was being completed', refunded: amount,
    });
  }

  /**
   * "Pay now" through the booking link. Records the card payment; a pending booking that is now
   * paid in full is confirmed. Money that arrives when it's no longer owed (cancelled meanwhile,
   * or paid another way) is refunded in full.
   */
  private async duePaid(bookingId: string, intentId: string, amount: number) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId }, include: { payments: { where: { deletedAt: null } } } });
    if (!booking) return;
    const cardLast4 = await this.stripe.cardLast4(intentId);
    if (booking.status === 'cancelled' || amount > dueOf(booking, booking.payments)) {
      return this.refundUnneeded(booking.id, intentId, amount, cardLast4);
    }
    const payments = [...booking.payments, { amount, status: 'succeeded' as const }];
    const paymentStatus = paymentStatusOf(booking.total, payments);
    const confirmNow = booking.status === 'pending' && paymentStatus === 'paid';
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: { bookingId, method: 'card', stripePaymentIntentId: intentId, cardLast4, amount, currency: env.CURRENCY, status: 'succeeded' },
      });
      await tx.booking.update({ where: { id: bookingId }, data: { paymentStatus, ...(confirmNow && { status: 'confirmed', confirmedAt: new Date() }) } });
      await tx.bookingEvent.createMany({
        data: [
          { bookingId, type: 'payment_received', detail: `Paid ${amount} by card online` },
          ...(confirmNow ? [{ bookingId, type: 'confirmed' as const, detail: 'Confirmed by online payment' }] : []),
        ],
      });
    });
    if (confirmNow) await this.notifier.confirmed(bookingId);
  }

  private async refundUnneeded(bookingId: string, intentId: string, amount: number, cardLast4: string | null) {
    const stripeRefundId = await this.stripe.refund(intentId);
    await this.prisma.$transaction([
      this.prisma.payment.create({
        data: {
          bookingId, method: 'card', stripePaymentIntentId: intentId, cardLast4, amount, currency: env.CURRENCY,
          status: 'refunded', stripeRefundId, refundedAt: new Date(),
        },
      }),
      this.prisma.bookingEvent.createMany({
        data: [
          { bookingId, type: 'payment_received', detail: `Paid ${amount} by card online` },
          { bookingId, type: 'refunded', detail: `Refunded ${amount}: nothing was due any more` },
        ],
      }),
    ]);
    await this.notifier.paymentRefunded(bookingId, amount);
  }

  private async expired(session: Stripe.Checkout.Session) {
    const bookingId = session.metadata?.bookingId;
    const booking = bookingId ? await this.prisma.booking.findUnique({ where: { id: bookingId } }) : null;
    if (booking?.status !== 'pending' || session.metadata?.purpose === 'due') return;
    await this.cancellation.cancel(booking.id, { actorId: null, reason: 'Payment not completed in time', refund: false, notify: false });
  }

  /** The customer can retry inside the same Checkout page, so the hold stays until it lapses. */
  private async failed(intent: Stripe.PaymentIntent) {
    const bookingId = intent.metadata?.bookingId;
    if (!bookingId) return;
    await this.prisma.booking.updateMany({ where: { id: bookingId, status: 'pending' }, data: { paymentStatus: 'failed' } });
  }

  /** A refund made in the Stripe dashboard: record it so the booking shows the truth. */
  private async refundedInStripe(charge: Stripe.Charge) {
    const intentId = idOf(charge.payment_intent);
    if (!intentId || !charge.refunded) return;
    const payment = await this.prisma.payment.findUnique({ where: { stripePaymentIntentId: intentId }, include: { booking: { include: { payments: true } } } });
    if (!payment || payment.status === 'refunded') return;
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'refunded', refundedAt: new Date() } });
      const payments = payment.booking.payments.map((p) => (p.id === payment.id ? { ...p, status: 'refunded' as const } : p));
      await tx.booking.update({ where: { id: payment.bookingId }, data: { paymentStatus: paymentStatusOf(payment.booking.total, payments) } });
      await tx.bookingEvent.create({ data: { bookingId: payment.bookingId, type: 'refunded', detail: `Refunded ${payment.amount} in Stripe` } });
    });
  }
}
