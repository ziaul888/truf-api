import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import type { BlockReason, Payment, Prisma } from '../generated/prisma/client.js';
import { StripeService } from '../payments/stripe.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SlotSettingsService } from '../slots/slot-settings.service.js';
import { fromDbDate, minutesUntil, venueNow } from '../slots/venue-time.js';
import { BookingNotifier } from './booking-notifier.service.js';
import { bookingNotFound, paymentStatusOf } from './booking-rules.js';
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
  /** Staff blocking the booked slot: the slot ends blocked instead of available. */
  blockSlot?: { reason: BlockReason; note?: string };
}

/** Refund ids by payment id (null for cash and bank transfer, refunded by hand). */
type Refunds = Map<string, string | null>;

/**
 * The one way a booking gets cancelled: by staff, by the customer, by the hold sweep, or by a
 * block over the slot. Refunds go first (outside the transaction): if Stripe refuses, nothing
 * changes and 502 REFUND_FAILED is returned.
 */
@Injectable()
export class BookingCancellationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly notifier: BookingNotifier,
    private readonly settings: SlotSettingsService,
  ) {}

  async cancel(bookingId: string, opts: CancelOptions): Promise<void> {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId }, include: BOOKING_INCLUDE });
    if (!booking || booking.deletedAt) throw bookingNotFound();
    await this.assertCancellable(booking, opts);

    const refunds: Refunds = opts.refund ? await this.refund(booking.payments) : new Map();
    await this.prisma.$transaction(async (tx) => {
      await this.markRefunded(tx, refunds);
      const payments = booking.payments.map((p) => (refunds.has(p.id) ? { ...p, status: 'refunded' as const } : p));
      await tx.booking.update({
        where: { id: bookingId },
        data: {
          status: 'cancelled', cancelledAt: new Date(), cancelReason: opts.reason ?? null, cancelledById: opts.actorId,
          liveSlotId: null, paymentStatus: paymentStatusOf(booking.total, payments),
        },
      });
      if (booking.liveSlotId) await this.releaseSlot(tx, booking, opts);
      await this.logEvents(tx, booking, opts, refunds);
    });

    const refunded = booking.payments.filter((p) => refunds.has(p.id)).reduce((sum, p) => sum + p.amount, 0);
    if (opts.notify) {
      await this.notifier.cancelled(bookingId, { reason: opts.reason, refunded, becauseBlocked: !!opts.blockSlot });
    }
  }

  private async assertCancellable(b: BookingRow, opts: CancelOptions) {
    if (b.status === 'cancelled') throw new AppError('This booking is already cancelled', 409, 'BOOKING_ALREADY_CANCELLED');
    const slotEnd = b.slot.startHour + b.slot.durationMinutes / 60;
    if (b.status === 'completed' || minutesUntil(venueNow(), fromDbDate(b.slot.date), slotEnd) <= 0) {
      throw new AppError('This booking has already taken place', 409, 'BOOKING_COMPLETED');
    }
    if (!opts.byCustomer) return;
    const { cancellationCutoffHours } = await this.settings.get();
    const started = minutesUntil(venueNow(), fromDbDate(b.slot.date), b.slot.startHour);
    if (b.source !== 'portal' || started <= cancellationCutoffHours * 60) {
      throw new AppError(
        `Bookings can't be cancelled online within ${cancellationCutoffHours} hours of the start. Please contact the venue`,
        400, 'CANCELLATION_WINDOW_PASSED',
      );
    }
  }

  /** Card payments go back through Stripe; cash and bank transfers are marked refunded (paid back by hand). */
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

  /** Frees the slot this booking held or booked, or blocks it when staff blocked over the booking. */
  private async releaseSlot(tx: Prisma.TransactionClient, b: BookingRow, opts: CancelOptions) {
    const cleared = { heldUntil: null, heldByBookingId: null };
    const data = opts.blockSlot
      ? {
        ...cleared, status: 'blocked' as const, blockReason: opts.blockSlot.reason, blockNote: opts.blockSlot.note ?? null,
        blockedById: opts.actorId, blockedAt: new Date(),
      }
      : { ...cleared, status: 'available' as const };
    await tx.slot.updateMany({ where: { id: b.slot.id, status: { in: ['held', 'booked'] } }, data });
    if (opts.blockSlot && opts.actorId) {
      await tx.slotEvent.create({
        data: {
          slotId: b.slot.id, groundId: b.ground.id, date: b.slot.date, startHour: b.slot.startHour, action: 'block',
          userId: opts.actorId, reason: opts.blockSlot.reason, note: opts.blockSlot.note ?? null,
        },
      });
    }
  }

  private async logEvents(tx: Prisma.TransactionClient, b: BookingRow, opts: CancelOptions, refunds: Refunds) {
    const by = opts.byCustomer ? 'Cancelled by the customer' : opts.actorId ? 'Cancelled by staff' : 'Cancelled automatically';
    const events: Prisma.BookingEventCreateManyInput[] = [
      { bookingId: b.id, type: 'cancelled', userId: opts.actorId, detail: opts.reason ? `${by}: ${opts.reason}` : by },
    ];
    const refunded = b.payments.filter((p) => refunds.has(p.id)).reduce((sum, p) => sum + p.amount, 0);
    if (refunded > 0) events.push({ bookingId: b.id, type: 'refunded', userId: opts.actorId, detail: `Refunded ${refunded}` });
    await tx.bookingEvent.createMany({ data: events });
  }
}
