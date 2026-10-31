import type { PrismaService } from '../prisma/prisma.service.js';
import type { StripeService } from '../payments/stripe.service.js';
import type { BookingCancellationService } from './booking-cancellation.service.js';
import { BookingJobs } from './booking-jobs.js';
import type { BookingNotifier } from './booking-notifier.service.js';
import type { SystemStateService } from '../settings/system-state.service.js';

// 04:00 UTC = 10:00 in Dhaka, Wed 28 Oct 2026.
const NOW = new Date('2026-10-28T04:00:00Z');
const today = new Date('2026-10-28T00:00:00Z');

function setup({ held = [] as object[], bookings = [] as object[], pending = { id: 'b-1', status: 'pending', stripeCheckoutSessionId: 'cs_1' } as object | null, lastDigest = null as string | null } = {}) {
  const prisma = {
    slot: { findMany: vi.fn(async () => held), updateMany: vi.fn(async () => ({ count: 1 })) },
    booking: {
      findUnique: vi.fn(async () => pending),
      findMany: vi.fn(async () => bookings),
      updateMany: vi.fn((args: { where: { id: { in: string[] } } }) => args),
      update: vi.fn(async () => ({})),
    },
    bookingEvent: { createMany: vi.fn((args: object) => args) },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  };
  const cancellation = { cancel: vi.fn(async () => undefined) };
  const stripe = { expireSession: vi.fn(async () => undefined) };
  const notifier = { paymentDue: vi.fn(async () => true), dueDigest: vi.fn(async (items: object[]) => items.length) };
  const state = { get: vi.fn(async () => ({ date: lastDigest })), set: vi.fn(async () => undefined) };
  const jobs = new BookingJobs(
    prisma as unknown as PrismaService, cancellation as unknown as BookingCancellationService,
    notifier as unknown as BookingNotifier, stripe as unknown as StripeService, state as unknown as SystemStateService,
  );
  return { jobs, prisma, cancellation, stripe, notifier, state };
}

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

describe('BookingJobs', () => {
  it('cancels the pending booking behind a lapsed hold and expires its Stripe session', async () => {
    const { jobs, cancellation, stripe } = setup({ held: [{ id: 's-1', heldByBookingId: 'b-1' }] });
    await expect(jobs.releaseExpiredHolds()).resolves.toBe(1);
    expect(cancellation.cancel).toHaveBeenCalledWith('b-1', expect.objectContaining({ refund: false }));
    expect(stripe.expireSession).toHaveBeenCalledWith('cs_1');
  });

  it('frees a held slot with no pending booking behind it', async () => {
    const { jobs, prisma, cancellation } = setup({ held: [{ id: 's-1', heldByBookingId: 'b-1' }], pending: null });
    await jobs.releaseExpiredHolds();
    expect(cancellation.cancel).not.toHaveBeenCalled();
    expect(prisma.slot.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'available' }) }));
  });

  it('completes only bookings whose slot has ended', async () => {
    const { jobs, prisma } = setup({
      bookings: [
        { id: 'ended', slot: { date: today, startHour: 8, durationMinutes: 120 } },
        { id: 'running', slot: { date: today, startHour: 9, durationMinutes: 120 } },
      ],
    });
    await expect(jobs.completeEnded()).resolves.toBe(1);
    expect(prisma.booking.updateMany.mock.calls[0]![0].where.id.in).toEqual(['ended']);
  });

  it('sends one due reminder per booking and remembers it', async () => {
    const { jobs, prisma, notifier } = setup({
      bookings: [{ id: 'b-1', status: 'confirmed', total: 1000, payments: [{ amount: 400, status: 'succeeded' }] }],
    });
    await expect(jobs.sendDueReminders()).resolves.toBe(1);
    expect(notifier.paymentDue).toHaveBeenCalledWith('b-1', 600);
    expect(prisma.booking.update).toHaveBeenCalledWith({ where: { id: 'b-1' }, data: { dueReminderSentAt: expect.any(Date) } });
  });

  it('sends the due digest once a day from 09:00, with overdue and due-today money only', async () => {
    const owing = (id: string, dueDate: string | null, date = '2026-10-30') => ({
      id, bookingNumber: `CT-${id}`, contactName: `C ${id}`, status: 'confirmed', total: 1000,
      dueDate: dueDate ? new Date(`${dueDate}T00:00:00Z`) : null, slot: { date: new Date(`${date}T00:00:00Z`), startHour: 18 }, payments: [],
    });
    const { jobs, notifier, state } = setup({ bookings: [owing('late', '2026-10-27'), owing('today', '2026-10-28'), owing('later', '2026-11-01')] });
    await jobs.sendDueDigest();
    expect(notifier.dueDigest).toHaveBeenCalledWith([
      { bookingNumber: 'CT-late', customerName: 'C late', due: 1000, overdue: true },
      { bookingNumber: 'CT-today', customerName: 'C today', due: 1000, overdue: false },
    ]);
    expect(state.set).toHaveBeenCalledWith('due_digest', { date: '2026-10-28' });

    const again = setup({ lastDigest: '2026-10-28' });
    await expect(again.jobs.sendDueDigest()).resolves.toBe(0);
    expect(again.notifier.dueDigest).not.toHaveBeenCalled();
  });
});
