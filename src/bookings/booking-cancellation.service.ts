import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import type { BlockReason, Payment, Prisma } from '../generated/prisma/client.js';
import { StripeService } from '../payments/stripe.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SlotSettingsService } from '../slots/slot-settings.service.js';
import { minutesUntil, venueNow } from '../slots/venue-time.js';
import { BookingNotifier } from './booking-notifier.service.js';
import {
  bookingChanged, bookingNotFound, isUnderReview, isWalletMethod, methodName, paymentStatusOf, paymentUnderReview,
} from './booking-rules.js';
import { liveSlots, primaryOf, windowHasEnded, windowOf, type BookingSlotRef } from './booking-slots.js';
import { BOOKING_INCLUDE, type BookingRow } from './booking.dto.js';

export interface CancelOptions {
  /** Staff member cancelling; null for the customer or the system. */
  actorId: string | null;
  reason?: string | null;
  /** Full refund of every payment to its original method (CLAUDE.md). */
  refund: boolean;
  notify: boolean;
  /** Customer through the signed link: portal bookings only, outside the cancellation cutoff. */
  byCustomer?: boolean;
  /** Staff "Reject": only while a bKash / Nagad payment is still unverified (else 409 PAYMENT_ALREADY_HANDLED). */
  rejectWallet?: boolean;
  /**
   * Staff blocking one booked slot: that slot ends blocked instead of available. The booking is still
   * cancelled whole (all or nothing), so its other slots become available.
   */
  blockSlot?: { reason: BlockReason; note?: string };
  /** Which of the booking's slots `blockSlot` applies to; default the earliest (the only one for a single-slot booking). */
  blockSlotId?: string;
  /**
   * The system giving up on a checkout that was never paid: acts only while the booking is still
   * pending, so a payment landing at the same moment wins, and also after the slot has ended.
   */
  unpaidOnly?: boolean;
}

/** Refund ids by payment id (null for cash, bank transfer, bKash and Nagad, refunded by hand). */
type Refunds = Map<string, string | null>;

/**
 * The one way a booking gets cancelled: by staff, by the customer, by the hold sweep, or by a
 * block over the slot. Refunds go first (outside the transaction): if Stripe refuses, nothing
 * changes and 502 REFUND_FAILED is returned. A bKash / Nagad payment staff never verified is
 * marked failed (staff "Reject" is this cancel), whether or not a refund was asked for.
 */
@Injectable()
export class BookingCancellationService {
  private readonly logger = new Logger(BookingCancellationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly notifier: BookingNotifier,
    private readonly settings: SlotSettingsService,
  ) {}

  /** Returns false only for `unpaidOnly`, when the booking is no longer pending and was left alone. */
  async cancel(bookingId: string, opts: CancelOptions): Promise<boolean> {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId }, include: BOOKING_INCLUDE });
    if (!booking || booking.deletedAt) throw bookingNotFound();
    if (opts.unpaidOnly && booking.status !== 'pending') return false;
    if (opts.rejectWallet && !isUnderReview(booking, booking.payments)) {
      throw new AppError('This payment was already verified or rejected. Reload the booking', 409, 'PAYMENT_ALREADY_HANDLED');
    }
    if (!opts.unpaidOnly) await this.assertCancellable(booking, opts);

    const refunds: Refunds = opts.refund ? await this.refund(booking.payments) : new Map();
    try {
      await this.prisma.$transaction((tx) => this.cancelInTx(tx, booking, opts, refunds));
    } catch (err) {
      // Stripe has already sent the money back: keep that on record even though the cancel failed.
      await this.keepStripeRefunds(booking, refunds, opts.actorId);
      // The system giving up on an unpaid checkout loses quietly to a payment that got in first.
      if (opts.unpaidOnly && err instanceof AppError && err.code === 'BOOKING_CHANGED') return false;
      throw err;
    }

    const refunded = booking.payments.filter((p) => refunds.has(p.id)).reduce((sum, p) => sum + p.amount, 0);
    if (opts.notify) {
      await this.notifier.cancelled(bookingId, { reason: opts.reason, refunded, becauseBlocked: !!opts.blockSlot });
    }
    return true;
  }

  private async cancelInTx(tx: Prisma.TransactionClient, booking: BookingRow, opts: CancelOptions, refunds: Refunds) {
    const bookingId = booking.id;
    // Re-read inside the transaction: something may have changed it since it was loaded (or while refunding).
    const current = await tx.booking.findUnique({ where: { id: bookingId }, select: { status: true } });
    if (current?.status !== booking.status) throw bookingChanged();
    const unverified = unverifiedOf(booking).map((p) => p.id);
    await this.markRefunded(tx, refunds);
    await failUnverified(tx, unverified);
    const payments = booking.payments.map((p) => (
      refunds.has(p.id) ? { ...p, status: 'refunded' as const } : unverified.includes(p.id) ? { ...p, status: 'failed' as const } : p
    ));
    // Only from the status it was read in: a Verify that got in first wins (409, rolled back).
    const { count } = await tx.booking.updateMany({
      where: { id: bookingId, status: booking.status },
      data: {
        status: 'cancelled', cancelledAt: new Date(), cancelReason: opts.reason ?? null, cancelledById: opts.actorId,
        liveSlotId: null, paymentStatus: paymentStatusOf(booking.total, payments),
      },
    });
    if (count === 0) throw bookingChanged();
    const live = liveSlots(booking);
    await tx.bookingSlot.updateMany({ where: { bookingId, cancelledAt: null }, data: { liveSlotId: null, cancelledAt: new Date() } });
    if (live.length > 0) await this.releaseSlots(tx, booking, live.map((s) => s.slot), opts);
    await this.logEvents(tx, booking, opts, refunds);
  }

  /**
   * The cancel rolled back after Stripe refunds went through: mark those payments refunded and log a
   * `refunded` event in their own transaction, so the booking never shows money Stripe already returned.
   */
  private async keepStripeRefunds(b: BookingRow, refunds: Refunds, actorId: string | null) {
    const done = new Map([...refunds].filter(([, stripeRefundId]) => stripeRefundId !== null));
    if (done.size === 0) return;
    const amount = b.payments.filter((p) => done.has(p.id)).reduce((sum, p) => sum + p.amount, 0);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.markRefunded(tx, done);
        const payments = await tx.payment.findMany({ where: { bookingId: b.id, deletedAt: null } });
        await tx.booking.update({ where: { id: b.id }, data: { paymentStatus: paymentStatusOf(b.total, payments) } });
        await tx.bookingEvent.create({
          data: { bookingId: b.id, type: 'refunded', userId: actorId, detail: `Refunded ${amount} in Stripe; the cancellation itself did not go through` },
        });
      });
    } catch (err) {
      const ids = [...done.values()].join(', ');
      this.logger.error(`Booking ${b.id}: Stripe refunds ${ids} could not be recorded`, err instanceof Error ? err.stack : String(err));
    }
  }

  private async assertCancellable(b: BookingRow, opts: CancelOptions) {
    if (b.status === 'cancelled') throw new AppError('This booking is already cancelled', 409, 'BOOKING_ALREADY_CANCELLED');
    // Like a completed booking: it has taken place (or would have). Staff undo the no-show first.
    if (b.status === 'no_show') throw new AppError('This booking is marked no-show. Undo the no-show first', 409, 'BOOKING_COMPLETED');
    const underReview = isUnderReview(b, b.payments);
    // The customer asks instead while staff verify (POST /bookings/:id/cancel-request).
    if (opts.byCustomer && underReview) throw paymentUnderReview('Your payment is being verified. Ask the venue to cancel instead');
    // Every staff path (cancel, blocking the slot over it): an unverified payment is verified or rejected first.
    if (underReview && !opts.rejectWallet) {
      throw new AppError('This bKash / Nagad payment is not verified yet: verify it first to refund it, or reject it', 409, 'VERIFY_OR_REJECT');
    }
    // Staff may still reject an unverified bKash / Nagad payment after the slot has ended.
    // Taken place once the last live slot has ended.
    const ended = windowHasEnded(venueNow(), windowOf(b));
    if (b.status === 'completed' || (ended && !(underReview && opts.rejectWallet))) {
      throw new AppError('This booking has already taken place', 409, 'BOOKING_COMPLETED');
    }
    if (!opts.byCustomer) return;
    const { cancellationCutoffHours } = await this.settings.get();
    // The cutoff counts from the earliest live slot.
    const window = windowOf(b);
    const started = minutesUntil(venueNow(), window.date, window.startMinutes / 60);
    if (b.source !== 'portal' || started <= cancellationCutoffHours * 60) {
      throw new AppError(
        `Bookings can't be cancelled online within ${cancellationCutoffHours} hours of the start. Please contact the venue`,
        400, 'CANCELLATION_WINDOW_PASSED',
      );
    }
  }

  /** Card payments go back through Stripe; cash, bank transfers, bKash and Nagad are marked refunded (paid back by hand). */
  private async refund(payments: Payment[]): Promise<Refunds> {
    const refunds: Refunds = new Map();
    for (const p of payments.filter((x) => x.status === 'succeeded')) {
      refunds.set(p.id, p.method === 'card' && p.stripePaymentIntentId ? await this.stripe.refund(p.stripePaymentIntentId) : null);
    }
    return refunds;
  }

  private async markRefunded(tx: Prisma.TransactionClient, refunds: Refunds) {
    for (const [id, stripeRefundId] of refunds) {
      await tx.payment.update({ where: { id }, data: { status: 'refunded', refundedAt: new Date(), stripeRefundId } });
    }
  }

  /** Frees every slot this booking held or booked, except the one staff blocked over the booking (it ends blocked). */
  private async releaseSlots(tx: Prisma.TransactionClient, b: BookingRow, slots: BookingSlotRef['slot'][], opts: CancelOptions) {
    const cleared = { heldUntil: null, heldByBookingId: null };
    const blocked = opts.blockSlot ? slots.find((s) => s.id === (opts.blockSlotId ?? primaryOf(b).slot.id)) : undefined;
    const freeIds = slots.filter((s) => s !== blocked).map((s) => s.id);
    if (freeIds.length > 0) {
      await tx.slot.updateMany({ where: { id: { in: freeIds }, status: { in: ['held', 'booked'] } }, data: { ...cleared, status: 'available' } });
    }
    if (!blocked || !opts.blockSlot) return;
    await tx.slot.updateMany({
      where: { id: blocked.id, status: { in: ['held', 'booked'] } },
      data: {
        ...cleared, status: 'blocked', blockReason: opts.blockSlot.reason, blockNote: opts.blockSlot.note ?? null,
        blockedById: opts.actorId, blockedAt: new Date(),
      },
    });
    if (opts.actorId) {
      await tx.slotEvent.create({
        data: {
          slotId: blocked.id, groundId: b.ground.id, date: blocked.date, startHour: blocked.startHour, action: 'block',
          userId: opts.actorId, reason: opts.blockSlot.reason, note: opts.blockSlot.note ?? null,
        },
      });
    }
  }

  private async logEvents(tx: Prisma.TransactionClient, b: BookingRow, opts: CancelOptions, refunds: Refunds) {
    const by = opts.byCustomer ? 'Cancelled by the customer' : opts.actorId ? 'Cancelled by staff' : 'Cancelled automatically';
    // "bKash payment (TrxID 9BC4D7XK2M) rejected"
    const rejected = unverifiedOf(b).map((p) => `${methodName(p.method)} payment (TrxID ${p.reference ?? 'none'}) rejected`);
    const detail = [opts.reason ? `${by}: ${opts.reason}` : by, ...rejected].join('. ');
    const events: Prisma.BookingEventCreateManyInput[] = [{ bookingId: b.id, type: 'cancelled', userId: opts.actorId, detail }];
    const refunded = b.payments.filter((p) => refunds.has(p.id)).reduce((sum, p) => sum + p.amount, 0);
    if (refunded > 0) events.push({ bookingId: b.id, type: 'refunded', userId: opts.actorId, detail: `Refunded ${refunded}` });
    await tx.bookingEvent.createMany({ data: events });
  }
}

/** bKash / Nagad payments staff never verified: they fail when the booking is cancelled. */
const unverifiedOf = (b: BookingRow) => b.payments.filter((p) => p.status === 'pending' && isWalletMethod(p.method));

/** Fails them; if one was verified meanwhile, aborts the cancel (409, rolled back). */
async function failUnverified(tx: Prisma.TransactionClient, ids: string[]) {
  if (ids.length === 0) return;
  const { count } = await tx.payment.updateMany({ where: { id: { in: ids }, status: 'pending' }, data: { status: 'failed' } });
  if (count < ids.length) throw bookingChanged();
}
