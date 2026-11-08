import type { PrismaService } from '../prisma/prisma.service.js';
import type { BookingCancellationService } from './booking-cancellation.service.js';
import type { BookingNotifier } from './booking-notifier.service.js';
import { StaffBookingsService } from './staff-bookings.service.js';

// 04:00 UTC = 10:00 in Dhaka, Wed 28 Oct 2026.
const NOW = new Date('2026-10-28T04:00:00Z');

const slot = {
  id: 's-1', groundId: 'g-1', date: new Date('2026-10-29T00:00:00Z'), startHour: 18, price: 1000, status: 'available',
  ground: { availableDays: 'everyday', customDays: [] },
};
const bookingRow = (overrides: object = {}) => ({
  id: 'b-1', status: 'pending', source: 'staff', total: 1000, payments: [{ amount: 400, status: 'succeeded' }], ...overrides,
});

function setup(booking: object = bookingRow(), foundSlot: object = slot) {
  const tx = {
    slot: { updateMany: vi.fn(async () => ({ count: 1 })) },
    customer: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({ id: 'c-1' })) },
    booking: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id: 'b-1' })), update: vi.fn(async (_args: { data: object }) => ({})),
      updateMany: vi.fn(async (_args: { where: object; data: object }) => ({ count: 1 })),
    },
    payment: {
      create: vi.fn(async ({ data }: { data: object }) => ({ ...data, status: 'succeeded' })),
      updateMany: vi.fn(async (_args: { where: object; data: object }) => ({ count: 1 })),
    },
    bookingEvent: { create: vi.fn(async (_args: { data: { type: string; detail?: string } }) => ({})) },
  };
  const prisma = {
    slot: { findUnique: vi.fn(async () => foundSlot) },
    customer: { findFirst: vi.fn(async () => ({ id: 'c-1' })) },
    booking: { findFirst: vi.fn(async () => booking), findUniqueOrThrow: vi.fn(async () => { throw new Error('dto not needed'); }) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifier = { confirmed: vi.fn(async () => true) };
  const cancellation = { cancel: vi.fn(async () => undefined) };
  const service = new StaffBookingsService(
    prisma as unknown as PrismaService, cancellation as unknown as BookingCancellationService, notifier as unknown as BookingNotifier,
  );
  return { service, tx, notifier, cancellation };
}

const customer = { name: 'Walk In', phone: '+8801711000000', email: 'w@x.test' };

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

describe('StaffBookingsService', () => {
  it('books with an advance as confirmed + partial, with no service fee', async () => {
    const { service, tx, notifier } = setup();
    await service.create('u-1', { slotId: 's-1', customer, payment: { type: 'partial', method: 'cash', amount: 400, dueDate: '2026-10-29', note: 'Rest later' } })
      .catch(() => undefined);
    expect(tx.booking.create.mock.calls[0]![0].data).toMatchObject({
      source: 'staff', status: 'confirmed', paymentStatus: 'partial', serviceFee: 0, total: 1000, dueNote: 'Rest later', createdById: 'u-1',
    });
    expect(notifier.confirmed).toHaveBeenCalledWith('b-1');
  });

  it('books without payment as pending, and sends no confirmation', async () => {
    const { service, tx, notifier } = setup();
    await service.create('u-1', { slotId: 's-1', customer, payment: { type: 'none' } }).catch(() => undefined);
    expect(tx.booking.create.mock.calls[0]![0].data).toMatchObject({ status: 'pending', paymentStatus: 'unpaid' });
    expect(notifier.confirmed).not.toHaveBeenCalled();
  });

  it('refuses an advance that covers the whole price', async () => {
    await expect(setup().service.create('u-1', { slotId: 's-1', customer, payment: { type: 'partial', method: 'cash', amount: 1000 } }))
      .rejects.toMatchObject({ status: 400, code: 'PAYMENT_EXCEEDS_DUE' });
  });

  it('refuses a free slot on a day the ground is closed, and takes nothing', async () => {
    const { service, tx, notifier } = setup(bookingRow(), { ...slot, ground: { availableDays: 'weekends', customDays: [] } });
    await expect(service.create('u-1', { slotId: 's-1', customer, payment: { type: 'none' } }))
      .rejects.toMatchObject({ status: 400, code: 'GROUND_CLOSED' });
    expect(tx.slot.updateMany).not.toHaveBeenCalled();
    expect(notifier.confirmed).not.toHaveBeenCalled();
  });

  it('refuses a payment above what is due', async () => {
    await expect(setup(bookingRow({ status: 'confirmed' })).service.recordPayment('u-1', 'b-1', { amount: 601, method: 'cash' }))
      .rejects.toMatchObject({ status: 400, code: 'PAYMENT_EXCEEDS_DUE' });
  });

  it('confirms a portal pay-at-venue booking', async () => {
    const { service, tx } = setup(bookingRow({ source: 'portal', payAtVenue: true, payments: [] }));
    await service.confirm('u-1', 'b-1', { markPaid: false, method: 'cash', notifyCustomer: false }).catch(() => undefined);
    expect(tx.booking.updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'confirmed', paymentStatus: 'unpaid' });
  });

  it('confirms with markPaid by recording the rest', async () => {
    const { service, tx } = setup();
    await service.confirm('u-1', 'b-1', { markPaid: true, method: 'cash', notifyCustomer: false }).catch(() => undefined);
    expect(tx.payment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 600, method: 'cash' }) });
    expect(tx.booking.updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
  });

  describe('bKash / Nagad bookings', () => {
    const walletBooking = (status = 'pending') => bookingRow({
      source: 'portal', payAtVenue: false, total: 6000,
      payments: [{ id: 'p-1', method: 'bkash', amount: 6000, status, reference: 'ABC123XYZ', payerNumber: '+8801811000000' }],
    });

    it('verify marks the pending payment received by the actor and confirms the booking as paid', async () => {
      const { service, tx } = setup(walletBooking());
      await service.confirm('u-1', 'b-1', { markPaid: false, method: 'cash', notifyCustomer: false }).catch(() => undefined);
      expect(tx.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'p-1', status: 'pending' }, data: { status: 'succeeded', recordedById: 'u-1', receivedAt: expect.any(Date) },
      });
      expect(tx.booking.updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
      const events = tx.bookingEvent.create.mock.calls.map((c) => c[0].data);
      expect(events[0]).toMatchObject({ type: 'payment_received', detail: expect.stringMatching(/^Received 6000 by bKash \(TrxID ABC123XYZ\)/) });
      expect(events[1]).toMatchObject({ type: 'confirmed' });
      expect(tx.payment.create).not.toHaveBeenCalled();
    });

    it('refuses when the payment was handled meanwhile', async () => {
      const { service, tx } = setup(walletBooking());
      tx.payment.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.confirm('u-1', 'b-1', { markPaid: false, method: 'cash', notifyCustomer: false }))
        .rejects.toMatchObject({ status: 409, code: 'BOOKING_NOT_PENDING' });
    });

    const confirmInput = { markPaid: false, method: 'cash' as const, notifyCustomer: false };

    it('refuses to verify when other payments already cover the total', async () => {
      const booking = walletBooking();
      booking.payments.unshift({ id: 'p-0', method: 'cash', amount: 6000, status: 'succeeded', reference: '', payerNumber: '' } as never);
      const { service, tx } = setup(booking);
      await expect(service.confirm('u-1', 'b-1', confirmInput)).rejects.toMatchObject({ status: 409, code: 'WALLET_PAYMENT_EXCEEDS_DUE' });
      expect(tx.payment.updateMany).not.toHaveBeenCalled();
    });

    it('verify loses cleanly when the booking was cancelled meanwhile', async () => {
      const { service, tx } = setup(walletBooking());
      tx.booking.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.confirm('u-1', 'b-1', confirmInput)).rejects.toMatchObject({ status: 409, code: 'BOOKING_CHANGED' });
    });

    it('no collecting payment while it is under review', async () => {
      const { service, tx } = setup(walletBooking());
      await expect(service.recordPayment('u-1', 'b-1', { amount: 6000, method: 'cash' }))
        .rejects.toMatchObject({ status: 409, code: 'PAYMENT_UNDER_REVIEW' });
      expect(tx.payment.create).not.toHaveBeenCalled();
    });

    it('cancel with a refund is refused until verified; reject (no refund) goes through', async () => {
      const { service, cancellation } = setup(walletBooking());
      await expect(service.cancel('u-1', 'b-1', { refund: true, notifyCustomer: false }))
        .rejects.toMatchObject({ status: 409, code: 'VERIFY_OR_REJECT' });
      expect(cancellation.cancel).not.toHaveBeenCalled();
      await service.cancel('u-1', 'b-1', { refund: false, notifyCustomer: false }).catch(() => undefined);
      expect(cancellation.cancel).toHaveBeenCalledWith('b-1', expect.objectContaining({ refund: false }));
    });

    it('a staff payment by Nagad keeps its TrxID; a reused one is 409 REFERENCE_ALREADY_USED', async () => {
      const { service, tx } = setup(bookingRow({ status: 'confirmed' }));
      await service.recordPayment('u-1', 'b-1', { amount: 600, method: 'nagad', reference: 'NG123456' }).catch(() => undefined);
      expect(tx.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ method: 'nagad', reference: 'NG123456', status: 'succeeded', receivedAt: expect.any(Date) }),
      });
      expect(tx.bookingEvent.create.mock.calls[0]![0].data.detail).toBe('Received 600 by Nagad (TrxID NG123456)');
      tx.payment.create.mockRejectedValueOnce(Object.assign(new Error('unique'), {
        code: 'P2002', meta: { driverAdapterError: { cause: { constraint: { index: 'Payment_method_reference_key' } } } },
      }));
      await expect(service.recordPayment('u-1', 'b-1', { amount: 600, method: 'nagad', reference: 'NG123456' }))
        .rejects.toMatchObject({ status: 409, code: 'REFERENCE_ALREADY_USED' });
    });
  });

  it.each([
    ['a confirmed booking', bookingRow({ status: 'confirmed' })],
    ['a card booking waiting for payment', bookingRow({ source: 'portal', payAtVenue: false })],
  ])('refuses to confirm %s', async (_label, booking) => {
    await expect(setup(booking).service.confirm('u-1', 'b-1', { markPaid: false, method: 'cash', notifyCustomer: false }))
      .rejects.toMatchObject({ status: 409, code: 'BOOKING_NOT_PENDING' });
  });
});
