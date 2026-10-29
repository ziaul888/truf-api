import type { PrismaService } from '../prisma/prisma.service.js';
import type { BookingCancellationService } from './booking-cancellation.service.js';
import type { BookingNotifier } from './booking-notifier.service.js';
import { StaffBookingsService } from './staff-bookings.service.js';

// 04:00 UTC = 10:00 in Dhaka, Wed 28 Oct 2026.
const NOW = new Date('2026-10-28T04:00:00Z');

const slot = { id: 's-1', groundId: 'g-1', date: new Date('2026-10-29T00:00:00Z'), startHour: 18, price: 1000, status: 'available' };
const bookingRow = (overrides: object = {}) => ({
  id: 'b-1', status: 'pending', source: 'staff', total: 1000, payments: [{ amount: 400, status: 'succeeded' }], ...overrides,
});

function setup(booking: object = bookingRow()) {
  const tx = {
    slot: { updateMany: vi.fn(async () => ({ count: 1 })) },
    customer: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({ id: 'c-1' })) },
    booking: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id: 'b-1' })), update: vi.fn(async (_args: { data: object }) => ({})) },
    payment: { create: vi.fn(async ({ data }: { data: object }) => ({ ...data, status: 'succeeded' })) },
    bookingEvent: { create: vi.fn(async () => ({})) },
  };
  const prisma = {
    slot: { findUnique: vi.fn(async () => slot) },
    customer: { findFirst: vi.fn(async () => ({ id: 'c-1' })) },
    booking: { findFirst: vi.fn(async () => booking), findUniqueOrThrow: vi.fn(async () => { throw new Error('dto not needed'); }) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifier = { confirmed: vi.fn(async () => true) };
  const service = new StaffBookingsService(
    prisma as unknown as PrismaService, { cancel: vi.fn() } as unknown as BookingCancellationService, notifier as unknown as BookingNotifier,
  );
  return { service, tx, notifier };
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

  it('refuses a payment above what is due', async () => {
    await expect(setup(bookingRow({ status: 'confirmed' })).service.recordPayment('u-1', 'b-1', { amount: 601, method: 'cash' }))
      .rejects.toMatchObject({ status: 400, code: 'PAYMENT_EXCEEDS_DUE' });
  });

  it('confirms a portal pay-at-venue booking', async () => {
    const { service, tx } = setup(bookingRow({ source: 'portal', payAtVenue: true, payments: [] }));
    await service.confirm('u-1', 'b-1', { markPaid: false, method: 'cash', notifyCustomer: false }).catch(() => undefined);
    expect(tx.booking.update.mock.calls[0]![0].data).toMatchObject({ status: 'confirmed', paymentStatus: 'unpaid' });
  });

  it('confirms with markPaid by recording the rest', async () => {
    const { service, tx } = setup();
    await service.confirm('u-1', 'b-1', { markPaid: true, method: 'cash', notifyCustomer: false }).catch(() => undefined);
    expect(tx.payment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 600, method: 'cash' }) });
    expect(tx.booking.update.mock.calls[0]![0].data).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
  });

  it.each([
    ['a confirmed booking', bookingRow({ status: 'confirmed' })],
    ['a card booking waiting for payment', bookingRow({ source: 'portal', payAtVenue: false })],
  ])('refuses to confirm %s', async (_label, booking) => {
    await expect(setup(booking).service.confirm('u-1', 'b-1', { markPaid: false, method: 'cash', notifyCustomer: false }))
      .rejects.toMatchObject({ status: 409, code: 'BOOKING_NOT_PENDING' });
  });
});
