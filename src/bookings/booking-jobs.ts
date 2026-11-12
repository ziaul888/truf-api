import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { trackJob } from '../common/job-runs.js';
import { env } from '../config/env.js';
import { StripeService } from '../payments/stripe.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SystemStateService } from '../settings/system-state.service.js';
import { addDays, toDbDate, venueNow } from '../slots/venue-time.js';
import { BookingCancellationService } from './booking-cancellation.service.js';
import { BookingNotifier } from './booking-notifier.service.js';
import { isDueToday, isOverdue, loadOwing } from './booking-due.js';
import { dueOf, WALLET_UNDER_REVIEW } from './booking-rules.js';
import { windowHasEnded, windowOf } from './booking-slots.js';

const MINUTE_MS = 60_000;
const SLOT_CLOCK = { id: true, date: true, startHour: true, startMinute: true, durationMinutes: true } as const;
/** The due digest goes out on the first hourly run from 09:00 venue time. */
const DIGEST_HOUR = 9;

/**
 * Every minute: release checkout holds that lapsed. Every hour: mark ended bookings completed,
 * send tomorrow's payment-due reminders, and from 09:00 the staff's daily due digest. Off under
 * tests (the specs call the methods).
 */
@Injectable()
export class BookingJobs implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BookingJobs.name);
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly cancellation: BookingCancellationService,
    private readonly notifier: BookingNotifier,
    private readonly stripe: StripeService,
    private readonly state: SystemStateService,
  ) {}

  onApplicationBootstrap() {
    if (env.NODE_ENV === 'test') return;
    this.every(MINUTE_MS, () => trackJob('holdExpiry', () => this.releaseExpiredHolds()));
    this.every(60 * MINUTE_MS, async () =>
      (await trackJob('completion', () => this.completeEnded()))
      + (await trackJob('dueReminders', () => this.sendDueReminders()))
      + (await trackJob('dueDigest', () => this.sendDueDigest())));
  }

  onModuleDestroy() {
    this.timers.forEach(clearInterval);
  }

  /** Releases every lapsed hold; one that fails is logged and retried next run without holding up the rest. */
  async releaseExpiredHolds(): Promise<number> {
    const slots = await this.prisma.slot.findMany({ where: { status: 'held', heldUntil: { lt: new Date() } } });
    const failures: unknown[] = [];
    for (const slot of slots) {
      try {
        await this.releaseHold(slot);
      } catch (err) {
        failures.push(err);
        this.logger.error(`Could not release the hold on slot ${slot.id}`, err instanceof Error ? err.stack : String(err));
      }
    }
    if (failures.length > 0) {
      throw new Error(`Hold release failed for ${failures.length} of ${slots.length} slots`, { cause: failures[0] });
    }
    return slots.length;
  }

  /** Cancels the unpaid booking behind a lapsed hold and expires its Stripe session. */
  private async releaseHold(slot: { id: string; heldByBookingId: string | null }) {
    const booking = slot.heldByBookingId ? await this.prisma.booking.findUnique({ where: { id: slot.heldByBookingId } }) : null;
    if (booking?.status === 'pending') {
      const cancelled = await this.cancellation.cancel(booking.id, {
        actorId: null, reason: 'Payment not completed in time', refund: false, notify: false, unpaidOnly: true,
      });
      if (cancelled && booking.stripeCheckoutSessionId) await this.stripe.expireSession(booking.stripeCheckoutSessionId);
      return;
    }
    // No pending booking behind it any more: just free the slot. Only if it is still held by the booking
    // we read: a stale snapshot must not free a slot another booking has taken a new hold on since.
    await this.prisma.slot.updateMany({
      where: { id: slot.id, status: 'held', heldByBookingId: slot.heldByBookingId },
      data: { status: 'available', heldUntil: null, heldByBookingId: null },
    });
  }

  /** Confirmed bookings whose last slot has ended become completed (and can no longer be cancelled). */
  async completeEnded(): Promise<number> {
    const now = venueNow();
    const candidates = await this.prisma.booking.findMany({
      where: { status: 'confirmed', deletedAt: null, slot: { date: { lte: toDbDate(now.date) } } },
      include: {
        slot: { select: SLOT_CLOCK },
        bookingSlots: { select: { price: true, cancelledAt: true, slot: { select: SLOT_CLOCK } } },
      },
    });
    const ended = candidates.filter((b) => windowHasEnded(now, windowOf(b)));
    if (ended.length === 0) return 0;
    const ids = ended.map((b) => b.id);
    await this.prisma.$transaction([
      this.prisma.booking.updateMany({ where: { id: { in: ids }, status: 'confirmed' }, data: { status: 'completed' } }),
      this.prisma.bookingEvent.createMany({ data: ids.map((bookingId) => ({ bookingId, type: 'completed' as const })) }),
    ]);
    return ids.length;
  }

  /** One reminder per booking, the day before its due date. */
  async sendDueReminders(): Promise<number> {
    const tomorrow = toDbDate(addDays(venueNow().date, 1));
    const bookings = await this.prisma.booking.findMany({
      where: {
        deletedAt: null, status: { in: ['pending', 'confirmed'] }, paymentStatus: { in: ['partial', 'unpaid'] },
        dueDate: tomorrow, dueReminderSentAt: null, NOT: WALLET_UNDER_REVIEW,
      },
      include: { payments: { where: { deletedAt: null } } },
    });
    for (const b of bookings) {
      await this.notifier.paymentDue(b.id, dueOf(b, b.payments));
      await this.prisma.booking.update({ where: { id: b.id }, data: { dueReminderSentAt: new Date() } });
    }
    return bookings.length;
  }

  /** Once a day from 09:00: overdue and due-today bookings (the dashboard's rules), to staff. */
  async sendDueDigest(): Promise<number> {
    const now = venueNow();
    if (now.minutes < DIGEST_HOUR * 60) return 0;
    const last = await this.state.get<{ date: string | null }>('due_digest', { date: null });
    if (last.date === now.date) return 0;
    const items = (await loadOwing(this.prisma))
      .filter((b) => isOverdue(b, now) || isDueToday(b, now))
      .map((b) => ({ bookingNumber: b.bookingNumber, customerName: b.customerName, due: b.due, overdue: isOverdue(b, now) }));
    const sent = await this.notifier.dueDigest(items);
    await this.state.set('due_digest', { date: now.date });
    return sent;
  }

  private every(ms: number, job: () => Promise<number>) {
    const run = () => job().catch((err) => this.logger.error('Booking job failed', err instanceof Error ? err.stack : String(err)));
    void run();
    const timer = setInterval(run, ms);
    timer.unref();
    this.timers.push(timer);
  }
}
