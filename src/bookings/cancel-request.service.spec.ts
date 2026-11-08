import type { PrismaService } from '../prisma/prisma.service.js';
import { DEFAULT_SLOT_SETTINGS, type SlotSettingsService } from '../slots/slot-settings.service.js';
import type { BookingNotifier } from './booking-notifier.service.js';
import { bookingToken } from './booking-rules.js';
import { CancelRequestService } from './cancel-request.service.js';

// 04:00 UTC = 10:00 in Dhaka, Wed 28 Oct 2026.
const NOW = new Date('2026-10-28T04:00:00Z');

const wallet = { id: 'p-1', method: 'bkash', amount: 6000, status: 'pending', reference: 'ABC123XYZ', payerNumber: '+8801811000000' };
const bookingRow = (overrides: object = {}) => ({
  id: 'b-1', status: 'pending', source: 'portal', total: 6000, cancelRequestedAt: null,
  slot: { date: new Date('2026-10-29T00:00:00Z'), startHour: 18 }, payments: [wallet], ...overrides,
});

function setup(booking: object | null = bookingRow()) {
  const tx = {
    booking: { updateMany: vi.fn(async (_args: object) => ({ count: 1 })) },
    bookingEvent: { create: vi.fn(async (_args: { data: { type: string; detail: string } }) => ({})) },
  };
  const prisma = {
    booking: { findFirst: vi.fn(async () => booking) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifier = { cancelRequestToStaff: vi.fn(async () => undefined) };
  const settings = { get: vi.fn(async () => DEFAULT_SLOT_SETTINGS) };
  const service = new CancelRequestService(
    prisma as unknown as PrismaService, settings as unknown as SlotSettingsService, notifier as unknown as BookingNotifier,
  );
  return { service, tx, notifier };
}

const token = bookingToken('b-1');

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

describe('CancelRequestService', () => {
  it('records the request once, logs it and emails staff', async () => {
    const { service, tx, notifier } = setup();
    await service.request('b-1', token);
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: 'b-1', status: 'pending', cancelRequestedAt: null }, data: { cancelRequestedAt: expect.any(Date) },
    });
    expect(tx.bookingEvent.create.mock.calls[0]![0].data).toMatchObject({ type: 'cancel_requested', detail: expect.stringContaining('TrxID ABC123XYZ') });
    expect(notifier.cancelRequestToStaff).toHaveBeenCalledWith('b-1');
  });

  it('a second request at the same moment is 409', async () => {
    const { service, tx, notifier } = setup();
    tx.booking.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.request('b-1', token)).rejects.toMatchObject({ status: 409, code: 'CANCEL_ALREADY_REQUESTED' });
    expect(notifier.cancelRequestToStaff).not.toHaveBeenCalled();
  });

  it.each([
    ['without a valid token', bookingRow(), 'nope', 404, 'BOOKING_NOT_FOUND'],
    ['already requested', bookingRow({ cancelRequestedAt: new Date() }), token, 409, 'CANCEL_ALREADY_REQUESTED'],
    ['not under review (verified)', bookingRow({ status: 'confirmed', payments: [{ ...wallet, status: 'succeeded' }] }), token, 409, 'NOT_UNDER_REVIEW'],
    ['not under review (cash)', bookingRow({ payments: [] }), token, 409, 'NOT_UNDER_REVIEW'],
    ['inside the cutoff', bookingRow({ slot: { date: new Date('2026-10-28T00:00:00Z'), startHour: 11 } }), token, 400, 'CANCELLATION_WINDOW_PASSED'],
    ['a staff booking', bookingRow({ source: 'staff' }), token, 400, 'CANCELLATION_WINDOW_PASSED'],
  ])('refuses %s', async (_label, booking, t, status, code) => {
    const { service, tx } = setup(booking);
    await expect(service.request('b-1', t)).rejects.toMatchObject({ status, code });
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });
});
