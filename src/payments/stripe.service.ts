import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import { AppError } from '../common/app-error.js';
import { env } from '../config/env.js';

export interface CheckoutSessionInput {
  bookingId: string;
  /** `booking` = the portal checkout; `due` = paying what's still owed through the booking link. */
  purpose?: 'booking' | 'due';
  total: number;
  description: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  id: string;
  url: string;
}

/** Stripe can't expire a Checkout Session sooner than 30 minutes; the hold sweep expires it earlier itself. */
const MIN_SESSION_SECONDS = 30 * 60 + 60;

const providerError = (message: string) => new AppError(message, 502, 'PAYMENT_PROVIDER_ERROR');

/**
 * The only place that talks to Stripe. Tests replace it with a mock.
 * Never log card data, secrets or full Stripe payloads.
 */
@Injectable()
export class StripeService {
  private client?: Stripe;

  private get stripe(): Stripe {
    if (!env.STRIPE_SECRET_KEY) throw providerError("Online payment isn't set up yet");
    this.client ??= new Stripe(env.STRIPE_SECRET_KEY);
    return this.client;
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
    const purpose = input.purpose ?? 'booking';
    const session = await this.call(() => this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: { currency: env.CURRENCY, unit_amount: input.total, product_data: { name: input.description } },
      }],
      customer_email: input.customerEmail,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: { bookingId: input.bookingId, purpose },
      payment_intent_data: { metadata: { bookingId: input.bookingId, purpose } },
      expires_at: Math.floor(Date.now() / 1000) + MIN_SESSION_SECONDS,
    }, purpose === 'booking' ? { idempotencyKey: `checkout-${input.bookingId}` } : undefined));
    if (!session.url) throw providerError('Stripe did not return a checkout link');
    return { id: session.id, url: session.url };
  }

  /** The session's link while it can still be paid, else null. */
  async openSessionUrl(sessionId: string): Promise<string | null> {
    const session = await this.call(() => this.stripe.checkout.sessions.retrieve(sessionId));
    return session.status === 'open' ? session.url : null;
  }

  /** Best effort: a session that is already complete or expired is fine. */
  async expireSession(sessionId: string): Promise<void> {
    try {
      await this.stripe.checkout.sessions.expire(sessionId);
    } catch {
      // Already expired or completed.
    }
  }

  /** Full refund of a payment; returns the Stripe refund id. Throws 502 REFUND_FAILED. */
  async refund(paymentIntentId: string): Promise<string> {
    try {
      const refund = await this.stripe.refunds.create(
        { payment_intent: paymentIntentId },
        { idempotencyKey: `refund-${paymentIntentId}` },
      );
      return refund.id;
    } catch {
      throw new AppError('The refund could not be processed. Try again or refund from the Stripe dashboard', 502, 'REFUND_FAILED');
    }
  }

  /** Last 4 digits of the card, for the receipt line; null if unavailable. */
  async cardLast4(paymentIntentId: string): Promise<string | null> {
    try {
      const intent = await this.stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
      const charge = intent.latest_charge;
      return typeof charge === 'object' && charge ? (charge.payment_method_details?.card?.last4 ?? null) : null;
    } catch {
      return null;
    }
  }

  /** Verifies the signature and parses a webhook. 400 INVALID_SIGNATURE when it doesn't match. */
  parseWebhook(rawBody: Buffer, signature: string | undefined): Stripe.Event {
    if (!env.STRIPE_WEBHOOK_SECRET) throw providerError('Stripe webhooks are not set up');
    try {
      return this.stripe.webhooks.constructEvent(rawBody, signature ?? '', env.STRIPE_WEBHOOK_SECRET);
    } catch {
      throw new AppError('Invalid Stripe signature', 400, 'INVALID_SIGNATURE');
    }
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw providerError('The payment provider is unavailable. Try again in a moment');
    }
  }
}
