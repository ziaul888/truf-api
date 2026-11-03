import { Logger } from '@nestjs/common';
import type { Ground, Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { SlotGeneratorService } from './slot-generator.service.js';
import { DEFAULT_SLOT_SETTINGS, SlotSettingsService } from './slot-settings.service.js';

// 04:00 UTC = 10:00 in Dhaka, Wed 28 Oct 2026.
const NOW = new Date('2026-10-28T04:00:00Z');

const ground = (overrides: Partial<Ground> = {}) => ({
  id: 'g-1', isActive: true, openingHour: 8, closingHour: 12, slotDurationMinutes: 60, hourlyPrice: 1000,
  peakPrice: null, peakRanges: [], availableDays: 'everyday', customDays: [], ...overrides,
}) as unknown as Ground;

function setup(found: Ground | null = ground(), settings = DEFAULT_SLOT_SETTINGS, closures: object[] = []) {
  const prisma = {
    closure: { findMany: vi.fn(async () => closures) },
    ground: {
      findUnique: vi.fn(async () => found),
      findMany: vi.fn(async () => (found ? [found] : [])),
    },
    slot: {
      findMany: vi.fn(async () => []),
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
    },
  };
  const settingsService = { get: vi.fn(async (_db?: unknown) => settings) };
  return { service: new SlotGeneratorService(prisma as unknown as PrismaService, settingsService as unknown as SlotSettingsService), prisma, settings: settingsService };
}

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

describe('SlotGeneratorService.generate', () => {
  const input = { groundId: 'g-1', fromDate: '2026-10-29', toDate: '2026-10-30', skipExisting: true as const, dryRun: false };

  it('creates the schedule for each day and reports the counts', async () => {
    const { service, prisma } = setup();
    await expect(service.generate(input)).resolves.toEqual({ generated: 8, skipped: 0, days: 2, slotsPerDay: 4 });
    expect(prisma.slot.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
  });

  it('creates slots on closure days already blocked by the closure', async () => {
    const closure = {
      id: 'c-1', fromDate: new Date('2026-10-30T00:00:00Z'), toDate: new Date('2026-10-30T00:00:00Z'),
      reason: 'event', note: 'Eid', createdById: 'u-1',
    };
    const { service, prisma } = setup(ground(), DEFAULT_SLOT_SETTINGS, [closure]);
    await service.generate(input);
    const rows = prisma.slot.createMany.mock.calls[0]![0].data as { date: Date; status?: string; closureId?: string }[];
    expect(rows.filter((r) => r.status === 'blocked').map((r) => r.date.toISOString().slice(0, 10))).toEqual(Array(4).fill('2026-10-30'));
    expect(rows.find((r) => r.status === 'blocked')).toMatchObject({ closureId: 'c-1', blockReason: 'event', blockNote: 'Eid' });
  });

  it('saves nothing on a dry run', async () => {
    const { service, prisma } = setup();
    await expect(service.generate({ ...input, dryRun: true })).resolves.toMatchObject({ generated: 8 });
    expect(prisma.slot.createMany).not.toHaveBeenCalled();
  });

  it.each([
    ['a past start', { fromDate: '2026-10-27' }, ground(), 'INVALID_DATE_RANGE'],
    ['a range with no open day', { toDate: '2026-10-29' }, ground({ availableDays: 'weekends' }), 'GROUND_CLOSED'],
    ['an inactive ground', {}, ground({ isActive: false }), 'GROUND_CLOSED'],
    ['an unknown ground', {}, null, 'GROUND_NOT_FOUND'],
  ])('rejects %s', async (_label, change, found, code) => {
    await expect(setup(found).service.generate({ ...input, ...change })).rejects.toMatchObject({ code });
  });
});

describe('SlotGeneratorService.fillWindow', () => {
  it('fills today (from the next hour) through the booking window', async () => {
    const { service } = setup(ground(), { ...DEFAULT_SLOT_SETTINGS, advanceBookingDays: 2 });
    // Today 10:00 → 11 only; then two full days of 4.
    await expect(service.fillWindow()).resolves.toBe(9);
  });

  it('does nothing when auto-generate is off', async () => {
    const { service, prisma } = setup(ground(), { ...DEFAULT_SLOT_SETTINGS, autoGenerate: false });
    await expect(service.fillWindow()).resolves.toBe(0);
    expect(prisma.ground.findMany).not.toHaveBeenCalled();
  });
});

describe('SlotGeneratorService.resync', () => {
  it('does all its reads and writes on the transaction it is given', async () => {
    const tx = {
      closure: { findMany: vi.fn(async () => []) },
      ground: { findUniqueOrThrow: vi.fn(async () => ground()) },
      slot: {
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(async () => ({ count: 2 })),
        createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
        count: vi.fn(async () => 9),
      },
    };
    const { service, prisma, settings } = setup(ground(), { ...DEFAULT_SLOT_SETTINGS, advanceBookingDays: 2 });
    await expect(service.resync(tx as unknown as Prisma.TransactionClient, 'g-1')).resolves.toEqual({ removed: 2, generated: 9, kept: 0 });
    expect(settings.get).toHaveBeenCalledWith(tx);
    expect(prisma.slot.createMany).not.toHaveBeenCalled();
  });
});

describe('SlotGeneratorService.retireClosedDays', () => {
  const thursday = new Date('2026-10-29T00:00:00Z');

  function retireSetup(failing: string[]) {
    const grounds = ['g-1', 'g-2', 'g-3'].map((id) => ground({ id, availableDays: 'weekends' }));
    const tx = {
      slot: {
        findMany: vi.fn(async ({ where }: { where: { groundId: string } }) => {
          if (failing.includes(where.groundId)) throw new Error(`boom ${where.groundId}`);
          return [{ id: `free-${where.groundId}`, date: thursday, _count: { bookings: 0 } }];
        }),
        deleteMany: vi.fn(async () => ({ count: 1 })),
        updateManyAndReturn: vi.fn(async () => []),
      },
      slotEvent: { createMany: vi.fn(async () => ({ count: 0 })) },
    };
    const prisma = {
      ground: { findMany: vi.fn(async (_args: object) => grounds) },
      $transaction: vi.fn(async (work: (t: typeof tx) => unknown) => work(tx)),
    };
    const settings = { get: vi.fn() } as unknown as SlotSettingsService;
    return { service: new SlotGeneratorService(prisma as unknown as PrismaService, settings), tx, prisma };
  }

  beforeEach(() => vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it('adds up every ground when all succeed', async () => {
    await expect(retireSetup([]).service.retireClosedDays()).resolves.toEqual({ removed: 3, blocked: 0 });
  });

  it('covers every weekends and weekdays ground by default, or only the ones named', async () => {
    const { service, prisma } = retireSetup([]);
    const days = { availableDays: { in: ['weekends', 'weekdays'] } };
    await service.retireClosedDays();
    expect(prisma.ground.findMany).toHaveBeenLastCalledWith({ where: days });
    await service.retireClosedDays(['g-2']);
    expect(prisma.ground.findMany).toHaveBeenLastCalledWith({ where: { ...days, id: { in: ['g-2'] } } });
  });

  it('carries on past a failing ground, then throws with the totals and the first cause', async () => {
    const { service, tx } = retireSetup(['g-1']);
    const err = await service.retireClosedDays().catch((e: Error) => e) as Error;

    expect(tx.slot.findMany).toHaveBeenCalledTimes(3);
    expect(tx.slot.deleteMany).toHaveBeenCalledTimes(2);
    expect(err.message).toBe('Closed-day cleanup failed for 1 of 3 grounds (2 free slots removed, 0 blocked)');
    expect(err.cause).toMatchObject({ message: 'boom g-1' });
    expect(Logger.prototype.error).toHaveBeenCalledWith('Closed-day cleanup failed for ground g-1', expect.any(String));
  });
});

describe('SlotSettingsService', () => {
  it('returns defaults until saved, and merges partial saves', async () => {
    const prisma = {
      slotSettings: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async ({ create }) => ({ ...create, updatedAt: NOW })),
      },
    };
    const service = new SlotSettingsService(prisma as unknown as PrismaService);
    await expect(service.get()).resolves.toEqual(DEFAULT_SLOT_SETTINGS);
    await expect(service.update({ autoGenerate: false })).resolves.toEqual({ ...DEFAULT_SLOT_SETTINGS, autoGenerate: false });
    expect(prisma.slotSettings.upsert.mock.calls[0]![0]).toMatchObject({ where: { id: 1 }, update: { autoGenerate: false } });
  });
});
