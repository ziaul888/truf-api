import type { PrismaService } from '../prisma/prisma.service.js';
import type { BookingCancellationService } from './booking-cancellation.service.js';
import type { BookingNotifier } from './booking-notifier.service.js';
import { StaffBookingsService } from './staff-bookings.service.js';

// 04:00 UTC = 10:00 in Dhaka, Wed 28 Oct 2026.
const NOW = new Date('2026-10-28T04:00:00Z');

const slot = {
  id: 's-1', groundId: 'g-1', date: new Date('2026-10-29T00:00:00Z'), startHour: 18, durationMinutes: 60, price: 1000, status: 'available',
  ground: { availableDays: 'everyday', customDays: [] },
};
const bookingRow = (overrides: object = {}) => ({
  id: 'b-1', status: 'pending', source: 'staff', total: 1000, payments: [{ amount: 400, status: 'succeeded' }], ...overrides,
});

function setup(booking: object = bookingRow(), foundSlot: object | object[] = slot, claimed = 1) {
  const tx = {
    slot: { updateMany: vi.fn(async (_args: { where: object; data: object }) => ({ count: claimed })) },
    customer: { findUnique: vi.fn(async (): Promise<object | null> => null), create: vi.fn(async () => ({ id: 'c-1' })) },
    booking: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id: 'b-1' })), update: vi.fn(async (_args: { data: object }) => ({})),
      updateMany: vi.fn(async (_args: { where: object; data: object }) => ({ count: 1 })),
    },
    bookingSlot: { updateMany: vi.fn(async (_args: { where: object; data: object }) => ({ count: 0 })) },
    payment: {
      create: vi.fn(async ({ data }: { data: object }) => ({ ...data, status: 'succeeded' })),
      updateMany: vi.fn(async (_args: { where: object; data: object }) => ({ count: 1 })),
    },
    bookingEvent: { create: vi.fn(async (_args: { data: { type: string; detail?: string } }) => ({})) },
  };
  const prisma = {
    slot: { findMany: vi.fn(async (_args: object) => [foundSlot].flat()) },
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

  it('books without an email: the customer\'s stored one if any, else none', async () => {
    const { service, tx } = setup();
    await service.create('u-1', { slotId: 's-1', customer: { ...customer, email: null }, payment: { type: 'none' } }).catch(() => undefined);
    expect(tx.customer.create).toHaveBeenCalledWith({ data: { name: 'Walk In', phone: customer.phone, email: null } });
    expect(tx.booking.create.mock.calls[0]![0].data).toMatchObject({ customerId: 'c-1', contactEmail: null });

    const known = setup();
    known.tx.customer.findUnique.mockResolvedValue({ email: 'stored@x.test' });
    await known.service.create('u-1', { slotId: 's-1', customer: { id: 'c-7', ...customer, email: undefined }, payment: { type: 'none' } })
      .catch(() => undefined);
    expect(known.tx.booking.create.mock.calls[0]![0].data).toMatchObject({ customerId: 'c-7', contactEmail: 'stored@x.test' });
  });

  describe('with several slots', () => {
    const second = { ...slot, id: 's-2', startHour: 19, price: 1200 };
    const third = { ...slot, id: 's-3', startHour: 21, price: 800 };

    it('books them together: amount is the sum, the earliest is the primary, one BookingSlot each', async () => {
      const { service, tx } = setup(bookingRow(), [third, slot, second], 3);
      await service.create('u-1', { slotIds: ['s-3', 's-1', 's-2'], customer, payment: { type: 'full', method: 'cash' } }).catch(() => undefined);
      expect(tx.slot.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.slot.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['s-1', 's-2', 's-3'] }, status: 'available' }, data: { status: 'booked' } });
      const data = tx.booking.create.mock.calls[0]![0].data;
      expect(data).toMatchObject({ slotId: 's-1', liveSlotId: 's-1', amount: 3000, total: 3000, serviceFee: 0, status: 'confirmed', paymentStatus: 'paid' });
      expect(data.payments).toMatchObject({ create: [expect.objectContaining({ amount: 3000 })] });
      expect(data.bookingSlots).toEqual({
        create: [
          { slotId: 's-1', liveSlotId: 's-1', price: 1000 }, { slotId: 's-2', liveSlotId: 's-2', price: 1200 }, { slotId: 's-3', liveSlotId: 's-3', price: 800 },
        ],
      });
    });

    it('first frees stale live BookingSlot rows of cancelled bookings on these slots', async () => {
      const { service, tx } = setup(bookingRow(), [slot, second], 2);
      await service.create('u-1', { slotIds: ['s-1', 's-2'], customer, payment: { type: 'none' } }).catch(() => undefined);
      expect(tx.bookingSlot.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { slotId: { in: ['s-1', 's-2'] }, liveSlotId: { not: null }, booking: { status: 'cancelled' } },
      }));
    });

    it('validates the advance against the combined total', async () => {
      const ok = setup(bookingRow(), [slot, second], 2);
      await ok.service.create('u-1', { slotIds: ['s-1', 's-2'], customer, payment: { type: 'partial', method: 'cash', amount: 1500 } }).catch(() => undefined);
      expect(ok.tx.booking.create.mock.calls[0]![0].data).toMatchObject({ total: 2200, paymentStatus: 'partial' });
      await expect(setup(bookingRow(), [slot, second], 2).service.create('u-1', { slotIds: ['s-1', 's-2'], customer, payment: { type: 'partial', method: 'cash', amount: 2200 } }))
        .rejects.toMatchObject({ code: 'PAYMENT_EXCEEDS_DUE' });
    });

    it('409s when any slot was taken meanwhile (count short), so the transaction rolls back', async () => {
      const { service, tx } = setup(bookingRow(), [slot, second], 1);
      await expect(service.create('u-1', { slotIds: ['s-1', 's-2'], customer, payment: { type: 'none' } }))
        .rejects.toMatchObject({ status: 409, code: 'SLOT_NOT_AVAILABLE' });
      expect(tx.booking.create).not.toHaveBeenCalled();
    });

    it('refuses slots on different dates or grounds', async () => {
      const otherDay = { ...second, date: new Date('2026-10-30T00:00:00Z') };
      await expect(setup(bookingRow(), [slot, otherDay]).service.create('u-1', { slotIds: ['s-1', 's-2'], customer, payment: { type: 'none' } }))
        .rejects.toMatchObject({ status: 400, code: 'SLOTS_MUST_SHARE_GROUND_DATE' });
      const otherGround = { ...second, groundId: 'g-2' };
      await expect(setup(bookingRow(), [slot, otherGround]).service.create('u-1', { slotIds: ['s-1', 's-2'], customer, payment: { type: 'none' } }))
        .rejects.toMatchObject({ status: 400, code: 'SLOTS_MUST_SHARE_GROUND_DATE' });
    });

    it('refuses more than 4 slots before reading any', async () => {
      const { service, tx } = setup();
      await expect(service.create('u-1', { slotIds: ['a', 'b', 'c', 'd', 'e'], customer, payment: { type: 'none' } }))
        .rejects.toMatchObject({ status: 400, code: 'TOO_MANY_SLOTS' });
      expect(tx.slot.updateMany).not.toHaveBeenCalled();
    });

    it('404s when one of the slots does not exist, and refuses one already booked', async () => {
      await expect(setup(bookingRow(), [slot]).service.create('u-1', { slotIds: ['s-1', 's-2'], customer, payment: { type: 'none' } }))
        .rejects.toMatchObject({ status: 404, code: 'SLOT_NOT_FOUND' });
      await expect(setup(bookingRow(), [slot, { ...second, status: 'booked' }]).service.create('u-1', { slotIds: ['s-1', 's-2'], customer, payment: { type: 'none' } }))
        .rejects.toMatchObject({ status: 409, code: 'SLOT_NOT_AVAILABLE' });
    });
  });

  it('resend confirmation without an email is 409 NO_EMAIL and sends nothing', async () => {
    const { service, notifier } = setup(bookingRow({ status: 'confirmed', contactEmail: null }));
    await expect(service.resendConfirmation('b-1')).rejects.toMatchObject({ status: 409, code: 'NO_EMAIL' });
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

  it('takes a walk-in on a slot that has started but not ended', async () => {
    const running = { ...slot, date: new Date('2026-10-28T00:00:00Z'), startHour: 9, durationMinutes: 120 };
    const { service, tx } = setup(bookingRow(), running);
    await service.create('u-1', { slotId: 's-1', customer, payment: { type: 'full', method: 'cash' } }).catch(() => undefined);
    expect(tx.booking.create).toHaveBeenCalled();
  });

  it('refuses a slot that has ended, and takes nothing', async () => {
    const ended = { ...slot, date: new Date('2026-10-28T00:00:00Z'), startHour: 9, durationMinutes: 60 };
    const { service, tx } = setup(bookingRow(), ended);
    await expect(service.create('u-1', { slotId: 's-1', customer, payment: { type: 'none' } }))
      .rejects.toMatchObject({ status: 400, code: 'SLOT_IN_PAST' });
    expect(tx.slot.updateMany).not.toHaveBeenCalled();
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

  describe('recording a payment on a pending booking', () => {
    it.each([
      ['a staff booking made without payment', bookingRow({ payments: [] }), 'partial'],
      ['a portal pay-at-venue booking, paid in full', bookingRow({ source: 'portal', payAtVenue: true, total: 400, payments: [] }), 'paid'],
    ])('confirms %s and emails the confirmation', async (_label, booking, paymentStatus) => {
      const { service, tx, notifier } = setup(booking);
      await service.recordPayment('u-1', 'b-1', { amount: 400, method: 'cash' }).catch(() => undefined);
      expect(tx.booking.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', status: 'pending' }, data: { paymentStatus, status: 'confirmed', confirmedAt: expect.any(Date) },
      });
      expect(tx.bookingEvent.create.mock.calls.map((c) => c[0].data.type)).toEqual(['payment_received', 'confirmed']);
      expect(notifier.confirmed).toHaveBeenCalledWith('b-1');
    });

    it('leaves a confirmed booking confirmed and sends nothing', async () => {
      const { service, tx, notifier } = setup(bookingRow({ status: 'confirmed' }));
      await service.recordPayment('u-1', 'b-1', { amount: 600, method: 'cash' }).catch(() => undefined);
      expect(tx.booking.updateMany).toHaveBeenCalledWith({ where: { id: 'b-1', status: 'confirmed' }, data: { paymentStatus: 'paid' } });
      expect(tx.bookingEvent.create.mock.calls.map((c) => c[0].data.type)).toEqual(['payment_received']);
      expect(notifier.confirmed).not.toHaveBeenCalled();
    });

    it('refuses a card booking still waiting for its card payment', async () => {
      const { service, tx } = setup(bookingRow({ source: 'portal', payAtVenue: false, payments: [] }));
      await expect(service.recordPayment('u-1', 'b-1', { amount: 400, method: 'cash' }))
        .rejects.toMatchObject({ status: 409, code: 'BOOKING_NOT_PENDING' });
      expect(tx.payment.create).not.toHaveBeenCalled();
    });

    it('loses cleanly when the booking was cancelled meanwhile', async () => {
      const { service, tx, notifier } = setup(bookingRow({ payments: [] }));
      tx.booking.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.recordPayment('u-1', 'b-1', { amount: 400, method: 'cash' })).rejects.toMatchObject({ status: 409, code: 'BOOKING_CHANGED' });
      expect(notifier.confirmed).not.toHaveBeenCalled();
    });
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

    it('"Reject" goes through the cancellation service with its flag (which enforces VERIFY_OR_REJECT)', async () => {
      const { service, cancellation } = setup(walletBooking());
      await service.cancel('u-1', 'b-1', { refund: false, notifyCustomer: false, rejectWalletPayment: true }).catch(() => undefined);
      expect(cancellation.cancel).toHaveBeenCalledWith('b-1', expect.objectContaining({ refund: false, rejectWallet: true }));
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
