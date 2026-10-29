import { AppError } from '../common/app-error.js';
import type { Ground, Slot } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { BookingCancellationService } from '../bookings/booking-cancellation.service.js';
import { SlotBlocksService } from './slot-blocks.service.js';
import { DEFAULT_SLOT_SETTINGS, type SlotSettingsService } from './slot-settings.service.js';
import type { SlotGeneratorService } from './slot-generator.service.js';

// Venue time is Asia/Dhaka (UTC+6): 04:00 UTC = 10:00 on Wed 28 Oct 2026.
const NOW = new Date('2026-10-28T04:00:00Z');

const slot = (overrides: Partial<Slot> = {}): Slot => ({
  id: 's-1', groundId: 'g-1', date: new Date('2026-10-29T00:00:00Z'), startHour: 18, durationMinutes: 60,
  price: 1500, status: 'available', blockReason: null, blockNote: null, blockedById: null, blockedAt: null, closureId: null,
  heldUntil: null, heldByBookingId: null, createdAt: NOW, updatedAt: NOW, ...overrides,
});

function setup(slots: Slot[] = [slot()], ground: Partial<Ground> | null = { id: 'g-1', isActive: true, availableDays: 'everyday', customDays: [] }) {
  const tx = {
    slot: {
      findUnique: vi.fn(async ({ where }) => slots.find((s) => s.id === where.id) ?? null),
      findMany: vi.fn(async (_args: { where: object }) => slots),
      updateMany: vi.fn(async ({ where }) => ({ count: where.id.in.length })),
    },
    slotEvent: { createMany: vi.fn(async (_args: { data: object[] }) => ({ count: 1 })) },
  };
  const prisma = {
    ...tx,
    ground: { findUnique: vi.fn(async () => ground) },
    slot: { ...tx.slot, findUniqueOrThrow: vi.fn(async () => ({ ...slots[0], ground: { name: 'Arena' }, blockedBy: null, bookings: [] })) },
    booking: { findFirst: vi.fn(async () => ({ id: 'b-1' })) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const generator = { fillDates: vi.fn(async (_tx: unknown, _groundId: string, _dates: string[]) => undefined) };
  const cancellation = { cancel: vi.fn(async (_id: string, _opts: object) => undefined) };
  const settings = { get: vi.fn(async () => DEFAULT_SLOT_SETTINGS) };
  const service = new SlotBlocksService(
    prisma as unknown as PrismaService, generator as unknown as SlotGeneratorService,
    cancellation as unknown as BookingCancellationService, settings as unknown as SlotSettingsService,
  );
  return { service, tx, generator, cancellation };
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect(err).toMatchObject({ status, code });
}

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

describe('SlotBlocksService — one slot', () => {
  it('blocks an available slot, records who did it, and logs the event', async () => {
    const { service, tx } = setup();
    const result = await service.block('u-1', 's-1', { reason: 'maintenance', note: 'Net repair' });

    expect(result.cancelledBooking).toBe(false);
    expect(tx.slot.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['s-1'] }, status: 'available' },
      data: expect.objectContaining({ status: 'blocked', blockReason: 'maintenance', blockNote: 'Net repair', blockedById: 'u-1' }),
    });
    expect(tx.slotEvent.createMany.mock.calls[0]![0].data).toEqual([
      expect.objectContaining({ slotId: 's-1', action: 'block', userId: 'u-1', reason: 'maintenance', note: 'Net repair' }),
    ]);
  });

  it.each([
    ['a booked slot', slot({ status: 'booked' }), 409, 'SLOT_HAS_BOOKING'],
    ['a blocked slot', slot({ status: 'blocked' }), 409, 'SLOT_ALREADY_BLOCKED'],
    ['a started slot', slot({ date: new Date('2026-10-28T00:00:00Z'), startHour: 10 }), 400, 'SLOT_IN_PAST'],
  ])('refuses to block %s', async (_label, s, status, code) => {
    await expectAppError(setup([s]).service.block('u-1', 's-1', { reason: 'other' }), status, code);
  });

  it('cancels and refunds the booking when cancelBooking is true, then blocks the slot', async () => {
    const { service, cancellation } = setup([slot({ status: 'booked' })]);
    const result = await service.block('u-1', 's-1', { reason: 'maintenance', note: 'Pipe burst', cancelBooking: true });
    expect(result.cancelledBooking).toBe(true);
    expect(cancellation.cancel).toHaveBeenCalledWith('b-1', expect.objectContaining({
      actorId: 'u-1', refund: true, notify: true, blockSlot: { reason: 'maintenance', note: 'Pipe burst' },
    }));
  });

  it('refuses to block a slot held by a checkout', async () => {
    await expectAppError(setup([slot({ status: 'held' })]).service.block('u-1', 's-1', { reason: 'other' }), 409, 'SLOT_NOT_AVAILABLE');
  });

  it('404s for an unknown slot', async () => {
    await expectAppError(setup([]).service.block('u-1', 's-1', { reason: 'other' }), 404, 'SLOT_NOT_FOUND');
  });

  it('unblocks only blocked slots and clears the block', async () => {
    await expectAppError(setup().service.unblock('u-1', 's-1'), 409, 'SLOT_NOT_BLOCKED');

    const { service, tx } = setup([slot({ status: 'blocked', blockReason: 'event' })]);
    await service.unblock('u-1', 's-1');
    expect(tx.slot.updateMany.mock.calls[0]![0].data).toEqual({
      status: 'available', blockReason: null, blockNote: null, blockedById: null, blockedAt: null, closureId: null,
    });
  });

  it('reports a conflict when the slot changed while saving', async () => {
    const { service, tx } = setup();
    tx.slot.updateMany.mockResolvedValueOnce({ count: 0 });
    await expectAppError(service.block('u-1', 's-1', { reason: 'other' }), 409, 'SLOT_NOT_AVAILABLE');
  });
});

describe('SlotBlocksService — bulk', () => {
  const base = { groundId: 'g-1', reason: 'event' as const };

  it('blocks a full day, skipping booked and started slots', async () => {
    const today = new Date('2026-10-28T00:00:00Z');
    const slots = [
      slot({ id: 'a', date: today, startHour: 9 }),
      slot({ id: 'b', date: today, startHour: 11 }),
      slot({ id: 'c', date: today, startHour: 12, status: 'booked' }),
    ];
    const { service, tx, generator } = setup(slots);
    const result = await service.bulkBlock('u-1', { ...base, type: 'fullDay', date: '2026-10-28' });

    expect(generator.fillDates).toHaveBeenCalledWith(tx, 'g-1', ['2026-10-28']);
    expect(tx.slot.updateMany.mock.calls[0]![0].where.id.in).toEqual(['b']);
    expect(result).toEqual({ blocked: 1, skippedBooked: 1, cancelledBookings: 0 });
  });

  it('blocks a weekly repeat on the chosen weekdays only', async () => {
    const { service, tx, generator } = setup([]);
    await service.bulkBlock('u-1', {
      ...base, type: 'recurringWeekly', date: '2026-11-01', untilDate: '2026-11-15', weekdays: ['sun'], startHour: 18,
    });
    expect(generator.fillDates.mock.calls[0]![2]).toEqual(['2026-11-01', '2026-11-08', '2026-11-15']);
    expect(tx.slot.findMany.mock.calls[0]![0].where).toMatchObject({ startHour: 18 });
  });

  it.each([
    ['a closed day', { type: 'fullDay', date: '2026-10-29' }, { availableDays: 'weekends' }, 400, 'GROUND_CLOSED'],
    ['a past date', { type: 'fullDay', date: '2026-10-27' }, {}, 400, 'SLOT_IN_PAST'],
    ['a repeat over a year', { type: 'recurringWeekly', date: '2026-11-01', untilDate: '2027-12-01', weekdays: ['sun'] }, {}, 400, 'INVALID_DATE_RANGE'],
  ])('rejects %s', async (_label, input, groundOverrides, status, code) => {
    const { service } = setup([], { id: 'g-1', isActive: true, availableDays: 'everyday', customDays: [], ...groundOverrides } as Partial<Ground>);
    await expectAppError(service.bulkBlock('u-1', { ...base, ...input } as never), status, code);
  });

  it('single type needs a slot that starts at that hour', async () => {
    await expectAppError(setup([]).service.bulkBlock('u-1', { ...base, type: 'single', date: '2026-10-29', startHour: 7 }), 404, 'SLOT_NOT_FOUND');
  });

  it('404s for an unknown ground', async () => {
    await expectAppError(setup([], null).service.bulkBlock('u-1', { ...base, type: 'fullDay', date: '2026-10-29' }), 404, 'GROUND_NOT_FOUND');
  });

  it('bulk-unblocks only upcoming blocked slots', async () => {
    const today = new Date('2026-10-28T00:00:00Z');
    const { service, tx } = setup([
      slot({ id: 'a', date: today, startHour: 8, status: 'blocked' }),
      slot({ id: 'b', date: today, startHour: 20, status: 'blocked' }),
    ]);
    await expect(service.bulkUnblock('u-1', { date: '2026-10-28' })).resolves.toEqual({ unblocked: 1 });
    expect(tx.slot.updateMany.mock.calls[0]![0].where.id.in).toEqual(['b']);
  });
});

describe('SlotBlocksService — bulk by id', () => {
  it('applies each id on its own and reports failures without rolling back the rest', async () => {
    const slots = [slot({ id: 'ok' }), slot({ id: 'booked', status: 'booked' })];
    const { service, tx } = setup(slots);
    const result = await service.bulkById('u-1', { ids: ['ok', 'booked', 'missing'], action: 'block', reason: 'event' });

    expect(result.done).toBe(1);
    expect(result.failed).toEqual([
      { id: 'booked', code: 'SLOT_HAS_BOOKING', error: expect.any(String) },
      { id: 'missing', code: 'SLOT_NOT_FOUND', error: 'Slot not found' },
    ]);
    expect(tx.slot.updateMany).toHaveBeenCalledTimes(1);
  });

  it('unblocks by id', async () => {
    const { service } = setup([slot({ id: 'b', status: 'blocked', blockReason: 'event' })]);
    await expect(service.bulkById('u-1', { ids: ['b'], action: 'unblock' })).resolves.toEqual({ done: 1, failed: [] });
  });
});
