import { AppError } from '../common/app-error.js';
import type { Ground, Slot } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SlotSettingsService } from './slot-settings.service.js';
import { DEFAULT_SLOT_SETTINGS } from './slot-settings.service.js';
import { SlotsService } from './slots.service.js';

// 04:00 UTC = 10:00 in Dhaka, Wed 28 Oct 2026.
const NOW = new Date('2026-10-28T04:00:00Z');
const day = (date: string) => new Date(`${date}T00:00:00Z`);

const slot = (overrides: Partial<Slot>): Slot => ({
  id: 's', groundId: 'g-1', date: day('2026-10-28'), startHour: 18, durationMinutes: 60, price: 1500,
  status: 'available', blockReason: null, blockNote: null, blockedById: null, blockedAt: null, closureId: null,
  heldUntil: null, heldByBookingId: null, createdAt: NOW, updatedAt: NOW, ...overrides,
});

const ground = {
  id: 'g-1', name: 'Arena', isActive: true, availableDays: 'everyday', customDays: [],
  hourlyPrice: 1500, peakPrice: 2000, peakRanges: [{ fromHour: 18, toHour: 22 }],
} as unknown as Ground;

function setup(slots: Slot[], foundGround: Ground | null = ground, closures: object[] = []) {
  const prisma = {
    ground: { findFirst: vi.fn(async () => foundGround) },
    closure: { findMany: vi.fn(async () => closures) },
    slot: {
      findMany: vi.fn(async () => slots.map((s) => ({ ...s, ground: { name: 'Arena' }, blockedBy: null, bookings: [] }))),
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => slots.length),
      groupBy: vi.fn(async (_args: { where: object }) => [{ status: 'available', _count: { _all: 3 } }, { status: 'blocked', _count: { _all: 1 } }]),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const settings = { get: vi.fn(async () => DEFAULT_SLOT_SETTINGS) };
  return { service: new SlotsService(prisma as unknown as PrismaService, settings as unknown as SlotSettingsService), prisma };
}

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

describe('SlotsService — customer availability', () => {
  it('marks only free slots outside the 2-hour cutoff and inside the window as available', async () => {
    const { service } = setup([
      slot({ id: 'started', startHour: 9 }),
      slot({ id: 'cutoff', startHour: 11 }),
      slot({ id: 'free', startHour: 13 }),
      slot({ id: 'peak', startHour: 18 }),
      slot({ id: 'blocked', startHour: 20, status: 'blocked', blockReason: 'event' }),
      slot({ id: 'too-far', date: day('2026-11-28'), startHour: 18 }),
    ]);
    const result = await service.listPublic('g-1', { from: '2026-10-28', to: '2026-10-28' });

    expect(Object.fromEntries(result.map((s) => [s.id, s.available]))).toEqual({
      started: false, cutoff: false, free: true, peak: true, blocked: false, 'too-far': false,
    });
    expect(result.find((s) => s.id === 'peak')).toEqual({
      id: 'peak', date: '2026-10-28', startHour: 18, endHour: 19, price: 1500, isPeak: true, available: true,
    });
    expect(result.find((s) => s.id === 'free')!.isPeak).toBe(false);
  });

  it('never reveals why a slot is unavailable', async () => {
    const [blocked] = await setup([slot({ status: 'blocked', blockReason: 'event', blockNote: 'VIP' })]).service
      .listPublic('g-1', { from: '2026-10-28', to: '2026-10-28' });
    expect(Object.keys(blocked!).sort()).toEqual(['available', 'date', 'endHour', 'id', 'isPeak', 'price', 'startHour']);
  });

  it('returns nothing on closed days', async () => {
    const { service } = setup([slot({})], { ...ground, availableDays: 'weekends' } as Ground);
    await expect(service.listPublic('g-1', { from: '2026-10-28', to: '2026-10-28' })).resolves.toEqual([]);
  });

  it('returns nothing on days inside a venue closure', async () => {
    const closure = { fromDate: day('2026-10-28'), toDate: day('2026-10-28') };
    const { service } = setup([slot({ id: 'a' }), slot({ id: 'b', date: day('2026-10-29') })], ground, [closure]);
    const result = await service.listPublic('g-1', { from: '2026-10-28', to: '2026-10-29' });
    expect(result.map((s) => s.id)).toEqual(['b']);
  });

  it('404s for hidden grounds and rejects ranges over 14 days', async () => {
    await expect(setup([], null).service.listPublic('g-1', { from: '2026-10-28', to: '2026-10-28' }))
      .rejects.toMatchObject({ status: 404, code: 'GROUND_NOT_FOUND' });
    await expect(setup([]).service.listPublic('g-1', { from: '2026-10-01', to: '2026-10-28' }))
      .rejects.toBeInstanceOf(AppError);
  });
});

describe('SlotsService — admin', () => {
  it('lists with stats that ignore the status filter', async () => {
    const { service, prisma } = setup([slot({ status: 'blocked', blockReason: 'event', blockedAt: NOW })]);
    const result = await service.list({ page: 1, limit: 20, groundId: 'g-1', from: '2026-10-28', to: '2026-10-28', status: 'blocked' });

    expect(prisma.slot.groupBy.mock.calls[0]![0].where).not.toHaveProperty('status');
    expect(result.stats).toEqual({ total: 4, available: 3, held: 0, booked: 0, blocked: 1 });
    expect(result.data[0]).toMatchObject({ groundName: 'Arena', date: '2026-10-28', endHour: 19, booking: null, block: { reason: 'event' } });
  });

  it('404s for an unknown slot', async () => {
    await expect(setup([]).service.get('x')).rejects.toMatchObject({ status: 404, code: 'SLOT_NOT_FOUND' });
  });
});
