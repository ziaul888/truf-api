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
  // Empty: a booking made by an older release; its single slot stands in. Multi-slot cases set this.
  bookingSlots: [],
  ground: { id: 'g-1' },
  payments: [payment()],
  ...overrides,
});

function setup(booking: object | null = bookingRow()) {
  const tx = {
    payment: {
      update: vi.fn(async (_args: object) => ({})), updateMany: vi.fn(async (_args: object) => ({ count: 1 })),
      findMany: vi.fn(async () => [{ amount: 6000, status: 'refunded' }]),
    },
    booking: {
      // Re-read inside the transaction: the status it was loaded with, unless a test changes it.
      findUnique: vi.fn(async () => ({ status: (booking as { status?: string } | null)?.status })),
      updateMany: vi.fn(async (_args: { where: object; data: object }) => ({ count: 1 })),
      update: vi.fn(async (_args: { data: object }) => ({})),
    },
    slot: { updateMany: vi.fn(async (_args: { where: object; data: object }) => ({ count: 1 })) },
    bookingSlot: { updateMany: vi.fn(async (_args: { where: object; data: object }) => ({ count: 1 })) },
    slotEvent: { create: vi.fn(async (_args: { data: object }) => ({})) },
    bookingEvent: {
      createMany: vi.fn(async (_args: { data: { type: string }[] }) => ({ count: 1 })),
      create: vi.fn(async (_args: { data: { type: string; detail: string } }) => ({})),
    },
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
    expect(tx.booking.updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'cancelled', liveSlotId: null, paymentStatus: 'refunded', cancelReason: 'Rain' });
    expect(tx.slot.updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'available', heldByBookingId: null });
    expect(tx.bookingEvent.createMany.mock.calls[0]![0].data.map((e) => e.type)).toEqual(['cancelled', 'refunded']);
    expect(notifier.cancelled).toHaveBeenCalledWith('b-1', expect.objectContaining({ refunded: 6000 }));
  });

  describe('unpaidOnly', () => {
    const unpaid = { actorId: null, refund: false, notify: false, unpaidOnly: true };

    it('leaves a booking that is no longer pending alone', async () => {
      const { service, prisma } = setup(bookingRow({ status: 'confirmed' }));
      await expect(service.cancel('b-1', unpaid)).resolves.toBe(false);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('frees nothing when a payment confirms the booking during the cancel', async () => {
      const { service, tx } = setup(bookingRow({ status: 'pending', payments: [] }));
      tx.booking.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.cancel('b-1', unpaid)).resolves.toBe(false);
      expect(tx.booking.updateMany.mock.calls[0]![0].where).toMatchObject({ status: 'pending' });
      expect(tx.slot.updateMany).not.toHaveBeenCalled();
      expect(tx.bookingEvent.createMany).not.toHaveBeenCalled();
    });

    it('still cancels after the slot has ended', async () => {
      const ended = { id: 's-1', date: day('2026-10-27'), startHour: 18, durationMinutes: 60 };
      const { service, tx } = setup(bookingRow({ status: 'pending', payments: [], slot: ended }));
      await expect(service.cancel('b-1', unpaid)).resolves.toBe(true);
      expect(tx.slot.updateMany).toHaveBeenCalled();
    });
  });

  it('marks cash payments refunded without calling Stripe', async () => {
    const { service, stripe, tx } = setup(bookingRow({ payments: [payment({ method: 'cash', stripePaymentIntentId: null })] }));
    await service.cancel('b-1', opts);
    expect(stripe.refund).not.toHaveBeenCalled();
    expect(tx.payment.update).toHaveBeenCalledWith({ where: { id: 'p-1' }, data: expect.objectContaining({ status: 'refunded', stripeRefundId: null }) });
  });

  it('marks a verified bKash payment refunded (paid back by hand) without calling Stripe', async () => {
    const { service, stripe, tx, notifier } = setup(bookingRow({ payments: [payment({ method: 'bkash', stripePaymentIntentId: null, reference: 'ABC123XYZ' })] }));
    await service.cancel('b-1', opts);
    expect(stripe.refund).not.toHaveBeenCalled();
    expect(tx.payment.update).toHaveBeenCalledWith({ where: { id: 'p-1' }, data: expect.objectContaining({ status: 'refunded', stripeRefundId: null }) });
    expect(tx.booking.updateMany.mock.calls[0]![0].data).toMatchObject({ paymentStatus: 'refunded' });
    expect(notifier.cancelled).toHaveBeenCalledWith('b-1', expect.objectContaining({ refunded: 6000 }));
  });

  it.each([
    ['refund: false', { refund: false, rejectWallet: true }], ['the reject path with refund: true', { refund: true, rejectWallet: true }],
  ])('fails a bKash payment staff never verified (%s), with nothing refunded', async (_label, extra) => {
    const pending = payment({ method: 'nagad', status: 'pending', stripePaymentIntentId: null, reference: 'NG123456' });
    const { service, stripe, tx, notifier } = setup(bookingRow({ status: 'pending', payments: [pending] }));
    await service.cancel('b-1', { ...opts, ...extra });
    expect(stripe.refund).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.payment.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['p-1'] }, status: 'pending' }, data: { status: 'failed' } });
    expect(tx.booking.updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'cancelled', paymentStatus: 'failed', liveSlotId: null });
    expect(tx.slot.updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'available' });
    expect(tx.bookingEvent.createMany.mock.calls[0]![0].data.map((e) => e.type)).toEqual(['cancelled']);
    expect(notifier.cancelled).toHaveBeenCalledWith('b-1', expect.objectContaining({ refunded: 0 }));
  });

  describe('an unverified bKash / Nagad payment', () => {
    const pending = () => payment({ method: 'nagad', status: 'pending', stripePaymentIntentId: null, reference: 'NG123456' });
    const ended = { id: 's-1', date: day('2026-10-28'), startHour: 8, durationMinutes: 60 };

    it('the reject event names the method and TrxID', async () => {
      const { service, tx } = setup(bookingRow({ status: 'pending', payments: [pending()] }));
      await service.cancel('b-1', { ...opts, refund: false, rejectWallet: true, reason: 'Not in our app' });
      expect(tx.bookingEvent.createMany.mock.calls[0]![0].data[0]).toMatchObject({
        detail: 'Cancelled by staff: Not in our app. Nagad payment (TrxID NG123456) rejected',
      });
    });

    it('aborts when it was verified meanwhile (payment or booking changed)', async () => {
      const first = setup(bookingRow({ status: 'pending', payments: [pending()] }));
      first.tx.payment.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(first.service.cancel('b-1', { ...opts, refund: false, rejectWallet: true })).rejects.toMatchObject({ status: 409, code: 'BOOKING_CHANGED' });
      expect(first.tx.booking.updateMany).not.toHaveBeenCalled();

      const second = setup(bookingRow({ status: 'pending', payments: [pending()] }));
      second.tx.booking.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(second.service.cancel('b-1', { ...opts, refund: false, rejectWallet: true })).rejects.toMatchObject({ status: 409, code: 'BOOKING_CHANGED' });
      expect(second.tx.booking.updateMany.mock.calls[0]![0].where).toEqual({ id: 'b-1', status: 'pending' });
    });

    it('staff may still reject it after the slot has ended; other cancels may not', async () => {
      const { service, tx } = setup(bookingRow({ status: 'pending', slot: ended, payments: [pending()] }));
      await service.cancel('b-1', { ...opts, refund: false, rejectWallet: true });
      expect(tx.booking.updateMany).toHaveBeenCalled();
      await expect(setup(bookingRow({ status: 'pending', slot: ended, payments: [payment({ method: 'cash' })] })).service.cancel('b-1', opts))
        .rejects.toMatchObject({ code: 'BOOKING_COMPLETED' });
    });

    it('a cancel that is not "Reject" is refused, before and after the slot has ended', async () => {
      for (const slot of [undefined, ended]) {
        const { service, prisma } = setup(bookingRow({ status: 'pending', ...(slot && { slot }), payments: [pending()] }));
        await expect(service.cancel('b-1', { ...opts, refund: false })).rejects.toMatchObject({ status: 409, code: 'VERIFY_OR_REJECT' });
        expect(prisma.$transaction).not.toHaveBeenCalled();
      }
    });

    it('"Reject" refuses once the payment was verified, instead of cancelling a paid booking', async () => {
      const { service, tx } = setup(bookingRow({ payments: [payment({ method: 'nagad', reference: 'NG123456' })] }));
      await expect(service.cancel('b-1', { ...opts, refund: false, rejectWallet: true }))
        .rejects.toMatchObject({ status: 409, code: 'PAYMENT_ALREADY_HANDLED' });
      expect(tx.booking.updateMany).not.toHaveBeenCalled();
    });

    it('the customer cannot cancel it directly', async () => {
      const { service, tx } = setup(bookingRow({ status: 'pending', payments: [pending()] }));
      await expect(service.cancel('b-1', { ...opts, actorId: null, byCustomer: true }))
        .rejects.toMatchObject({ status: 409, code: 'PAYMENT_UNDER_REVIEW' });
      expect(tx.booking.updateMany).not.toHaveBeenCalled();
    });
  });

  it('refuses a refund cancel on an unverified payment from every caller, the slot block included', async () => {
    const pending = payment({ method: 'bkash', status: 'pending', stripePaymentIntentId: null, reference: 'ABC123XYZ' });
    const { service, prisma } = setup(bookingRow({ status: 'pending', payments: [pending] }));
    await expect(service.cancel('b-1', { ...opts, blockSlot: { reason: 'maintenance' } }))
      .rejects.toMatchObject({ status: 409, code: 'VERIFY_OR_REJECT' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('stops when the booking changed between loading and the transaction', async () => {
    const { service, tx, stripe } = setup(bookingRow({ status: 'pending', payments: [payment({ method: 'cash' })] }));
    tx.booking.findUnique.mockResolvedValueOnce({ status: 'confirmed' });
    await expect(service.cancel('b-1', opts)).rejects.toMatchObject({ status: 409, code: 'BOOKING_CHANGED' });
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
    expect(stripe.refund).not.toHaveBeenCalled();
  });

  it('keeps a Stripe refund on record when the cancel then rolls back', async () => {
    const { service, tx, stripe, prisma, notifier } = setup();
    tx.booking.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.cancel('b-1', opts)).rejects.toMatchObject({ status: 409, code: 'BOOKING_CHANGED' });
    expect(stripe.refund).toHaveBeenCalledWith('pi_1');
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.payment.update).toHaveBeenLastCalledWith({ where: { id: 'p-1' }, data: expect.objectContaining({ status: 'refunded', stripeRefundId: 're_pi_1' }) });
    expect(tx.booking.update).toHaveBeenCalledWith({ where: { id: 'b-1' }, data: { paymentStatus: 'refunded' } });
    expect(tx.bookingEvent.create.mock.calls[0]![0].data).toMatchObject({ type: 'refunded', detail: expect.stringMatching(/^Refunded 6000 in Stripe/) });
    expect(notifier.cancelled).not.toHaveBeenCalled();
  });

  it('records nothing extra when a cash cancel rolls back (no money moved)', async () => {
    const { service, tx, prisma } = setup(bookingRow({ payments: [payment({ method: 'cash', stripePaymentIntentId: null })] }));
    tx.booking.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.cancel('b-1', opts)).rejects.toMatchObject({ code: 'BOOKING_CHANGED' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
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

  describe('a booking with several slots (cancelled whole)', () => {
    const slotAt = (id: string, startHour: number) => ({ id, date: day('2026-10-29'), startHour, startMinute: 0, durationMinutes: 60 });
    const multi = (overrides: object = {}) => bookingRow({
      slot: slotAt('s-1', 18),
      bookingSlots: [18, 19, 21].map((h, i) => ({ price: 1500, cancelledAt: null, slot: slotAt(`s-${i + 1}`, h) })),
      ...overrides,
    });

    it('clears every BookingSlot live index and frees all the slots in one update', async () => {
      const { service, tx } = setup(multi());
      await service.cancel('b-1', opts);
      expect(tx.bookingSlot.updateMany).toHaveBeenCalledWith({
        where: { bookingId: 'b-1', cancelledAt: null }, data: { liveSlotId: null, cancelledAt: expect.any(Date) },
      });
      expect(tx.slot.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.slot.updateMany.mock.calls[0]![0]).toMatchObject({
        where: { id: { in: ['s-1', 's-2', 's-3'] }, status: { in: ['held', 'booked'] } }, data: { status: 'available', heldByBookingId: null },
      });
    });

    it('blocks only the slot being blocked; the others become available', async () => {
      const { service, tx } = setup(multi());
      await service.cancel('b-1', { ...opts, blockSlot: { reason: 'maintenance' }, blockSlotId: 's-2' });
      const calls = tx.slot.updateMany.mock.calls.map(([args]) => args);
      expect(calls[0]).toMatchObject({ where: { id: { in: ['s-1', 's-3'] } }, data: { status: 'available' } });
      expect(calls[1]).toMatchObject({ where: { id: 's-2' }, data: { status: 'blocked', blockReason: 'maintenance', blockedById: 'u-1' } });
      expect(tx.slotEvent.create).toHaveBeenCalledTimes(1);
      expect(tx.slotEvent.create.mock.calls[0]![0]).toMatchObject({ data: { slotId: 's-2', action: 'block' } });
    });

    it('is over only when the LAST slot has ended', async () => {
      // 10:00 now: slot 1 (08:00-09:00) is over, slot 2 (11:00-12:00) is not.
      const rows = [8, 11].map((h, i) => ({ price: 1500, cancelledAt: null, slot: { ...slotAt(`s-${i + 1}`, h), date: day('2026-10-28') } }));
      const running = multi({ slot: rows[0]!.slot, bookingSlots: rows });
      await expect(setup(running).service.cancel('b-1', opts)).resolves.toBe(true);
      const over = multi({ slot: rows[0]!.slot, bookingSlots: [rows[0]] });
      await expect(setup(over).service.cancel('b-1', opts)).rejects.toMatchObject({ code: 'BOOKING_COMPLETED' });
    });

    it('applies the customer cutoff from the EARLIEST slot', async () => {
      const rows = [11, 14].map((h, i) => ({ price: 1500, cancelledAt: null, slot: { ...slotAt(`s-${i + 1}`, h), date: day('2026-10-28') } }));
      const booking = multi({ slot: rows[0]!.slot, bookingSlots: rows });
      await expect(setup(booking).service.cancel('b-1', { ...opts, byCustomer: true })).rejects.toMatchObject({ code: 'CANCELLATION_WINDOW_PASSED' });
    });
  });

  it.each([
    ['an unknown booking', null, {}, 404, 'BOOKING_NOT_FOUND'],
    ['a cancelled booking', bookingRow({ status: 'cancelled' }), {}, 409, 'BOOKING_ALREADY_CANCELLED'],
    ['a no-show, even before its slot ends', bookingRow({ status: 'no_show' }), {}, 409, 'BOOKING_COMPLETED'],
    ['a booking whose slot has ended', bookingRow({ slot: { id: 's-1', date: day('2026-10-28'), startHour: 8, durationMinutes: 60 } }), {}, 409, 'BOOKING_COMPLETED'],
    ['a customer inside the cutoff', bookingRow({ slot: { id: 's-1', date: day('2026-10-28'), startHour: 11, durationMinutes: 60 } }), { byCustomer: true }, 400, 'CANCELLATION_WINDOW_PASSED'],
    ['a customer inside the cutoff of a 12:00 slot (2 hours at 10:00)', bookingRow({ slot: { id: 's-1', date: day('2026-10-28'), startHour: 12, startMinute: 0, durationMinutes: 90 } }), { byCustomer: true }, 400, 'CANCELLATION_WINDOW_PASSED'],
    ['a customer cancelling a staff booking', bookingRow({ source: 'staff' }), { byCustomer: true }, 400, 'CANCELLATION_WINDOW_PASSED'],
  ])('refuses %s', async (_label, booking, extra, status, code) => {
    await expect(setup(booking).service.cancel('b-1', { ...opts, ...extra })).rejects.toMatchObject({ status, code });
  });

  it('lets a customer cancel a 12:30 slot at 10:00: the cutoff counts from the half hour', async () => {
    const booking = bookingRow({ slot: { id: 's-1', date: day('2026-10-28'), startHour: 12, startMinute: 30, durationMinutes: 90 } });
    await expect(setup(booking).service.cancel('b-1', { ...opts, byCustomer: true })).resolves.not.toThrow();
  });
});
