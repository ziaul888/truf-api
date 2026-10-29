import { AppError } from '../common/app-error.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { StripeService } from '../payments/stripe.service.js';
import { DEFAULT_SLOT_SETTINGS, type SlotSettingsService } from '../slots/slot-settings.service.js';
import { BookingCancellationService } from './booking-cancellation.service.js';
import type { BookingNotifier } from './booking-notifier.service.js';

// 04:00 UTC = 10:00 in Dhaka, Wed 28 Oct 2026.
const NOW = new Date('2026-10-28T04:00:00Z');
const day = (date: string) => new Date(`${date}T00:00:00Z`);

const payment = (overrides: object = {}) => ({
  id: 'p-1', method: 'card', amount: 6000, status: 'succeeded', stripePaymentIntentId: 'pi_1', ...overrides,
});
const bookingRow = (overrides: object = {}) => ({
  id: 'b-1', status: 'confirmed', source: 'portal', total: 6000, liveSlotId: 's-1', deletedAt: null,
  slot: { id: 's-1', date: day('2026-10-29'), startHour: 18, durationMinutes: 60 },
  ground: { id: 'g-1' },
  payments: [payment()],
  ...overrides,
});

function setup(booking: object | null = bookingRow()) {
  const tx = {
    payment: { update: vi.fn(async () => ({})) },
    booking: { update: vi.fn(async (_args: { data: object }) => ({})) },
    slot: { updateMany: vi.fn(async (_args: { data: object }) => ({ count: 1 })) },
    slotEvent: { create: vi.fn(async () => ({})) },
    bookingEvent: { createMany: vi.fn(async (_args: { data: { type: string }[] }) => ({ count: 1 })) },
  };
  const prisma = {
    booking: { findUnique: vi.fn(async () => booking) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const stripe = { refund: vi.fn(async (id: string) => `re_${id}`) };
  const notifier = { cancelled: vi.fn(async () => true) };
  const settings = { get: vi.fn(async () => DEFAULT_SLOT_SETTINGS) };
  const service = new BookingCancellationService(
    prisma as unknown as PrismaService, stripe as unknown as StripeService,
    notifier as unknown as BookingNotifier, settings as unknown as SlotSettingsService,
  );
  return { service, tx, stripe, notifier, prisma };
}

const opts = { actorId: 'u-1', refund: true, notify: true };

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

describe('BookingCancellationService', () => {
  it('refunds card payments through Stripe, frees the slot and emails the customer', async () => {
    const { service, tx, stripe, notifier } = setup();
    await service.cancel('b-1', { ...opts, reason: 'Rain' });

    expect(stripe.refund).toHaveBeenCalledWith('pi_1');
    expect(tx.payment.update).toHaveBeenCalledWith({ where: { id: 'p-1' }, data: expect.objectContaining({ status: 'refunded', stripeRefundId: 're_pi_1' }) });
    expect(tx.booking.update.mock.calls[0]![0].data).toMatchObject({ status: 'cancelled', liveSlotId: null, paymentStatus: 'refunded', cancelReason: 'Rain' });
    expect(tx.slot.updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'available', heldByBookingId: null });
    expect(tx.bookingEvent.createMany.mock.calls[0]![0].data.map((e) => e.type)).toEqual(['cancelled', 'refunded']);
    expect(notifier.cancelled).toHaveBeenCalledWith('b-1', expect.objectContaining({ refunded: 6000 }));
  });

  it('marks cash payments refunded without calling Stripe', async () => {
    const { service, stripe, tx } = setup(bookingRow({ payments: [payment({ method: 'cash', stripePaymentIntentId: null })] }));
    await service.cancel('b-1', opts);
    expect(stripe.refund).not.toHaveBeenCalled();
    expect(tx.payment.update).toHaveBeenCalledWith({ where: { id: 'p-1' }, data: expect.objectContaining({ status: 'refunded', stripeRefundId: null }) });
  });

  it('changes nothing when Stripe refuses the refund', async () => {
    const { service, stripe, prisma } = setup();
    stripe.refund.mockRejectedValueOnce(new AppError('no', 502, 'REFUND_FAILED'));
    await expect(service.cancel('b-1', opts)).rejects.toMatchObject({ status: 502, code: 'REFUND_FAILED' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('blocks the slot instead of freeing it when staff block over the booking', async () => {
    const { service, tx } = setup();
    await service.cancel('b-1', { ...opts, blockSlot: { reason: 'maintenance', note: 'Pipe' } });
    expect(tx.slot.updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'blocked', blockReason: 'maintenance', blockedById: 'u-1' });
    expect(tx.slotEvent.create).toHaveBeenCalled();
  });

  it.each([
    ['an unknown booking', null, {}, 404, 'BOOKING_NOT_FOUND'],
    ['a cancelled booking', bookingRow({ status: 'cancelled' }), {}, 409, 'BOOKING_ALREADY_CANCELLED'],
    ['a booking whose slot has ended', bookingRow({ slot: { id: 's-1', date: day('2026-10-28'), startHour: 8, durationMinutes: 60 } }), {}, 409, 'BOOKING_COMPLETED'],
    ['a customer inside the cutoff', bookingRow({ slot: { id: 's-1', date: day('2026-10-28'), startHour: 11, durationMinutes: 60 } }), { byCustomer: true }, 400, 'CANCELLATION_WINDOW_PASSED'],
    ['a customer cancelling a staff booking', bookingRow({ source: 'staff' }), { byCustomer: true }, 400, 'CANCELLATION_WINDOW_PASSED'],
  ])('refuses %s', async (_label, booking, extra, status, code) => {
    await expect(setup(booking).service.cancel('b-1', { ...opts, ...extra })).rejects.toMatchObject({ status, code });
  });
});
