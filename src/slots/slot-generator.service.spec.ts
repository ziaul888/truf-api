import type { Ground } from '../generated/prisma/client.js';
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
  const settingsService = { get: vi.fn(async () => settings) } as unknown as SlotSettingsService;
  return { service: new SlotGeneratorService(prisma as unknown as PrismaService, settingsService), prisma };
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
    ['a range with no open day', {}, ground({ availableDays: 'weekends' }), 'GROUND_CLOSED'],
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
