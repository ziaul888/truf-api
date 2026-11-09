import type { PrismaService } from '../prisma/prisma.service.js';
import type { BookingCancellationService } from './booking-cancellation.service.js';
import type { BookingNotifier } from './booking-notifier.service.js';
import { StaffBookingsService } from './staff-bookings.service.js';

// 04:00 UTC = 10:00 in Dhaka, Wed 28 Oct 2026.
const NOW = new Date('2026-10-28T04:00:00Z');
const TODAY = new Date('2026-10-28T00:00:00Z');

/** 08:00–09:00 today: started and ended. */
const ENDED = { id: 's-1', date: TODAY, startHour: 8, durationMinutes: 60 };
/** 09:00–11:00 today: started, not ended. */
const PLAYING = { ...ENDED, startHour: 9, durationMinutes: 120 };
/** 18:00 today: not started. */
const LATER = { ...ENDED, startHour: 18 };

const row = (overrides: object = {}) => ({
  id: 'b-1', bookingNumber: 'CT-AAAAA', status: 'confirmed', source: 'staff', payAtVenue: false, total: 1000, amount: 1000, serviceFee: 0,
  payments: [{ id: 'p-1', amount: 400, status: 'succeeded', method: 'cash', payerNumber: null }],
  slot: ENDED, confirmedAt: new Date('2026-10-27T10:00:00Z'), cancelRequestedAt: null,
  ground: { id: 'g-1', name: 'Main', sport: 'football' }, customer: { id: 'c-1', name: 'A', phone: null, email: 'a@x.test' },
  contactName: 'A', contactEmail: 'a@x.test', contactPhone: '+8801711000000', dueDate: null, dueNote: null, notes: null, createdBy: null,
  cancelledAt: null, cancelReason: null, createdAt: NOW, updatedAt: NOW,
  ...overrides,
});

function setup(booking: object, updated = 1) {
  const tx = {
    booking: { updateMany: vi.fn(async (_args: { where: object; data: object }) => ({ count: updated })) },
    bookingEvent: { create: vi.fn(async (_args: { data: { type: string; detail?: string; userId?: string } }) => ({})) },
  };
  const prisma = {
    booking: { findFirst: vi.fn(async () => booking), findUniqueOrThrow: vi.fn(async () => booking) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifier = { confirmed: vi.fn(async () => true) };
  const service = new StaffBookingsService(
    prisma as unknown as PrismaService, {} as BookingCancellationService, notifier as unknown as BookingNotifier,
  );
  return { service, tx, notifier };
}

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

describe('StaffBookingsService.markNoShow', () => {
  it.each(['pending', 'confirmed', 'completed'])('marks a %s booking no-show from the status it was read in', async (status) => {
    const { service, tx, notifier } = setup(row({ status }));
    await service.markNoShow('u-1', 'b-1', {});
    expect(tx.booking.updateMany).toHaveBeenCalledWith({ where: { id: 'b-1', status }, data: { status: 'no_show' } });
    expect(tx.bookingEvent.create).toHaveBeenCalledWith({
      data: { bookingId: 'b-1', type: 'no_show', userId: 'u-1', detail: 'No-show: 600 due written off' },
    });
    expect(notifier.confirmed).not.toHaveBeenCalled();
  });

  it('changes only the status: payments, payment status and the slot are left alone', async () => {
    const { service, tx } = setup(row());
    await service.markNoShow('u-1', 'b-1', {});
    expect(tx.booking.updateMany.mock.calls[0]![0].data).toEqual({ status: 'no_show' });
  });

  it('works once the slot has started, before it ends', async () => {
    const { service, tx } = setup(row({ slot: PLAYING }));
    await service.markNoShow('u-1', 'b-1', { reason: 'Phone off' });
    expect(tx.bookingEvent.create.mock.calls[0]![0].data.detail).toBe('No-show: 600 due written off: Phone off');
  });

  it('says so when nothing was due', async () => {
    const { service, tx } = setup(row({ payments: [{ id: 'p-1', amount: 1000, status: 'succeeded', method: 'cash', payerNumber: null }] }));
    await service.markNoShow('u-1', 'b-1', {});
    expect(tx.bookingEvent.create.mock.calls[0]![0].data.detail).toBe('No-show: no due written off');
  });

  it.each([
    ['a cancelled booking', row({ status: 'cancelled' }), 'BOOKING_ALREADY_CANCELLED'],
    ['a no-show', row({ status: 'no_show' }), 'ALREADY_NO_SHOW'],
    ['a slot that has not started', row({ slot: LATER }), 'SLOT_NOT_STARTED'],
    [
      'a bKash payment under review',
      row({ status: 'pending', source: 'portal', payments: [{ id: 'p-1', amount: 1000, status: 'pending', method: 'bkash', payerNumber: '+8801811000000' }] }),
      'VERIFY_OR_REJECT',
    ],
    ['a card checkout in progress', row({ status: 'pending', source: 'portal', payments: [] }), 'BOOKING_NOT_PENDING'],
  ])('refuses %s (409 %s)', async (_name, booking, code) => {
    const { service, tx } = setup(booking);
    await expect(service.markNoShow('u-1', 'b-1', {})).rejects.toMatchObject({ status: 409, code });
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it('loses to a change that got in first (409 BOOKING_CHANGED) and logs nothing', async () => {
    const { service, tx } = setup(row(), 0);
    await expect(service.markNoShow('u-1', 'b-1', {})).rejects.toMatchObject({ status: 409, code: 'BOOKING_CHANGED' });
    expect(tx.bookingEvent.create).not.toHaveBeenCalled();
  });
});

describe('StaffBookingsService.undoNoShow', () => {
  it('goes back to completed when the slot has ended', async () => {
    const { service, tx } = setup(row({ status: 'no_show' }));
    await service.undoNoShow('u-1', 'b-1');
    expect(tx.booking.updateMany.mock.calls[0]![0]).toMatchObject({ where: { id: 'b-1', status: 'no_show' }, data: { status: 'completed' } });
    expect(tx.bookingEvent.create).toHaveBeenCalledWith({ data: { bookingId: 'b-1', type: 'completed', userId: 'u-1', detail: 'No-show undone' } });
  });

  it('goes back to confirmed while the slot is still on, and sets confirmedAt when it was never confirmed', async () => {
    const { service, tx } = setup(row({ status: 'no_show', slot: PLAYING, confirmedAt: null }));
    await service.undoNoShow('u-1', 'b-1');
    expect(tx.booking.updateMany.mock.calls[0]![0].data).toEqual({ status: 'confirmed', confirmedAt: NOW });
    expect(tx.bookingEvent.create.mock.calls[0]![0].data.type).toBe('confirmed');
  });

  it('keeps an existing confirmedAt', async () => {
    const confirmedAt = new Date('2026-10-27T10:00:00Z');
    const { service, tx } = setup(row({ status: 'no_show', confirmedAt }));
    await service.undoNoShow('u-1', 'b-1');
    expect(tx.booking.updateMany.mock.calls[0]![0].data).toMatchObject({ confirmedAt });
  });

  it('refuses a booking that is not a no-show (409 NOT_NO_SHOW)', async () => {
    await expect(setup(row()).service.undoNoShow('u-1', 'b-1')).rejects.toMatchObject({ status: 409, code: 'NOT_NO_SHOW' });
  });

  it('loses to a change that got in first (409 BOOKING_CHANGED)', async () => {
    await expect(setup(row({ status: 'no_show' }), 0).service.undoNoShow('u-1', 'b-1')).rejects.toMatchObject({ code: 'BOOKING_CHANGED' });
  });
});

describe('collecting a payment on a no-show', () => {
  it('is refused (409 BOOKING_NO_SHOW): staff undo the no-show first', async () => {
    const { service, tx } = setup(row({ status: 'no_show' }));
    await expect(service.recordPayment('u-1', 'b-1', { amount: 100, method: 'cash' })).rejects.toMatchObject({ status: 409, code: 'BOOKING_NO_SHOW' });
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });
});
