import { AppError } from '../common/app-error.js';
import type { Ground } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SlotGeneratorService } from '../slots/slot-generator.service.js';
import { CreateGroundSchema, UpdateGroundSchema } from './grounds.schemas.js';
import { GroundsService } from './grounds.service.js';

const ground = (overrides: Partial<Ground> = {}): Ground => ({
  id: 'g-1',
  name: 'Green Arena',
  description: null,
  rules: null,
  address: null,
  mapUrl: null,
  hourlyPrice: 1500,
  openingHour: 8,
  closingHour: 22,
  isActive: true,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  sport: 'football',
  format: '5x5',
  surface: null,
  dimensions: null,
  capacity: 10,
  amenities: ['Parking'],
  availableDays: 'everyday',
  customDays: [],
  showOnPortal: true,
  internalNotes: 'Gate code 1234',
  peakPrice: null,
  peakRanges: [],
  slotDurationMinutes: 60,
  photos: [],
  ...overrides,
});

function setup(existing: Ground | null = ground()) {
  const prisma = {
    ground: {
      findUnique: vi.fn(async () => existing),
      findFirst: vi.fn(async () => existing),
      findMany: vi.fn(async () => (existing ? [existing] : [])),
      count: vi.fn(async () => (existing ? 1 : 0)),
      create: vi.fn(async ({ data }) => ground({ ...data, id: 'new-id' })),
      update: vi.fn(async ({ data }) => ({ ...existing!, ...data })),
    },
    $transaction: vi.fn((ops: Promise<unknown>[] | ((tx: unknown) => unknown)) => (typeof ops === 'function' ? ops(prisma) : Promise.all(ops))),
  };
  const slots = {
    fillWindow: vi.fn(async () => 0),
    resync: vi.fn(async () => ({ removed: 0, generated: 0, kept: 0 })),
  };
  return { service: new GroundsService(prisma as unknown as PrismaService, slots as unknown as SlotGeneratorService), prisma, slots };
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect(err).toMatchObject({ status, code });
}

const newGround = CreateGroundSchema.parse({
  name: 'New', sport: 'cricket', hourlyPrice: 2000, openingHour: 6, closingHour: 23,
});

describe('GroundsService — public', () => {
  it('lists only visible grounds, applies filters, and hides staff-only fields', async () => {
    const { service, prisma } = setup();
    const result = await service.listPublic({ page: 1, limit: 20, search: 'green', sport: 'football', format: '5x5' });

    expect(prisma.ground.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        name: { contains: 'green', mode: 'insensitive' }, sport: 'football', format: '5x5',
        isActive: true, showOnPortal: true,
      },
    }));
    expect(result).toMatchObject({ total: 1, page: 1, limit: 20 });
    for (const key of ['isActive', 'showOnPortal', 'internalNotes', 'createdAt']) {
      expect(result.data[0]).not.toHaveProperty(key);
    }
    expect(result.data[0]).toMatchObject({ sport: 'football', capacity: 10, amenities: ['Parking'] });
  });

  it('looks a single ground up with the same visibility rule', async () => {
    const { service, prisma } = setup();
    await service.getPublic('g-1');
    expect(prisma.ground.findFirst).toHaveBeenCalledWith({ where: { id: 'g-1', isActive: true, showOnPortal: true } });
  });

  it('404s when the ground is hidden', async () => {
    await expectAppError(setup(null).service.getPublic('g-1'), 404, 'GROUND_NOT_FOUND');
  });
});

describe('GroundsService — admin', () => {
  it('returns staff-only fields to the dashboard', async () => {
    await expect(setup().service.get('g-1')).resolves.toMatchObject({ internalNotes: 'Gate code 1234', showOnPortal: true });
  });

  it('returns 404 for an unknown ground', async () => {
    await expectAppError(setup(null).service.get('missing'), 404, 'GROUND_NOT_FOUND');
  });

  it('creates a ground with defaults filled in', async () => {
    const dto = await setup().service.create(newGround);
    expect(dto).toMatchObject({
      id: 'new-id', sport: 'cricket', isActive: true, showOnPortal: true,
      amenities: [], availableDays: 'everyday', customDays: [],
    });
  });

  it('drops custom days unless availability is custom', async () => {
    const { service, prisma } = setup();
    await service.create({ ...newGround, availableDays: 'weekends', customDays: ['mon'] });
    expect(prisma.ground.create.mock.calls[0]![0].data).toMatchObject({ availableDays: 'weekends', customDays: [] });
  });

  it('requires at least one day for custom availability, on create and update', async () => {
    const { service } = setup();
    await expectAppError(service.create({ ...newGround, availableDays: 'custom' }), 400, 'INVALID_DAYS');
    await expectAppError(service.update('g-1', { availableDays: 'custom' }), 400, 'INVALID_DAYS');
  });

  it('checks custom days on update against the stored availability', async () => {
    const { service, prisma } = setup(ground({ availableDays: 'custom', customDays: ['sat'] }));
    await service.update('g-1', { customDays: ['sat', 'sun'] });
    expect(prisma.ground.update.mock.calls[0]![0].data).toMatchObject({ availableDays: 'custom', customDays: ['sat', 'sun'] });
  });

  it('checks a single changed hour against the stored one', async () => {
    const { service, prisma } = setup(ground({ openingHour: 8, closingHour: 22 }));
    await expectAppError(service.update('g-1', { openingHour: 22 }), 400, 'INVALID_HOURS');
    expect(prisma.ground.update).not.toHaveBeenCalled();

    await expect(service.update('g-1', { closingHour: 23 })).resolves.toMatchObject({ closingHour: 23 });
  });
});

describe('slot sync', () => {
  it('generates slots for a new ground', async () => {
    const { service, slots } = setup();
    await service.create(newGround);
    expect(slots.fillWindow).toHaveBeenCalledWith(['new-id']);
  });

  it('resyncs slots when the schedule changes, and reports it', async () => {
    const { service, slots } = setup();
    await expect(service.update('g-1', { slotDurationMinutes: 120 })).resolves.toMatchObject({ slotSync: { kept: 0 } });
    expect(slots.resync).toHaveBeenCalledWith(expect.anything(), 'g-1');
  });

  it('leaves slots alone for other edits', async () => {
    const { service, slots } = setup();
    const dto = await service.update('g-1', { name: 'Renamed' });
    expect(slots.resync).not.toHaveBeenCalled();
    expect(dto).not.toHaveProperty('slotSync');
  });

  it('leaves slots alone when a save resends the stored schedule', async () => {
    const stored = ground({
      availableDays: 'custom', customDays: ['sat', 'fri'], peakPrice: 2500,
      peakRanges: [{ toHour: 22, fromHour: 17 }, { toHour: 12, fromHour: 10 }] as unknown as Ground['peakRanges'],
    });
    const { service, slots } = setup(stored);
    const dto = await service.update('g-1', {
      openingHour: 8, closingHour: 22, hourlyPrice: 1500, slotDurationMinutes: 60, isActive: true, peakPrice: 2500,
      availableDays: 'custom', customDays: ['fri', 'sat'],
      peakRanges: [{ fromHour: 10, toHour: 12 }, { fromHour: 17, toHour: 22 }],
    });
    expect(slots.resync).not.toHaveBeenCalled();
    expect(dto).not.toHaveProperty('slotSync');
  });

  it.each([
    ['a peak range', { peakPrice: 2500, peakRanges: [{ fromHour: 17, toHour: 21 }] }],
    ['the peak price', { peakPrice: 2600 }],
    ['the days', { availableDays: 'weekends' as const }],
  ])('resyncs when %s really changes', async (_label, change) => {
    const { service, slots } = setup(ground({ peakPrice: 2500, peakRanges: [{ fromHour: 17, toHour: 22 }] as unknown as Ground['peakRanges'] }));
    await service.update('g-1', change);
    expect(slots.resync).toHaveBeenCalledWith(expect.anything(), 'g-1');
  });

  describe('when the resync fails', () => {
    /** A database with real commit and rollback: a transaction's writes count only if its callback finishes. */
    function committing() {
      let stored = ground();
      const prisma = {
        ground: { findUnique: vi.fn(async () => stored) },
        $transaction: vi.fn(async (work: (tx: unknown) => unknown, _options: { timeout: number }) => {
          let draft = stored;
          const result = await work({
            ground: { update: async ({ data }: { data: Partial<Ground> }) => (draft = { ...draft, ...data }) },
          });
          stored = draft;
          return result;
        }),
      };
      const slots = { resync: vi.fn(async (_tx: unknown, _id: string) => ({ removed: 1, generated: 1, kept: 0 })) };
      const service = new GroundsService(prisma as unknown as PrismaService, slots as unknown as SlotGeneratorService);
      return { service, prisma, slots, stored: () => stored };
    }

    it('leaves the ground unchanged, and the retry resyncs', async () => {
      const { service, prisma, slots, stored } = committing();
      slots.resync.mockRejectedValueOnce(new Error('db down'));

      await expect(service.update('g-1', { availableDays: 'weekends' })).rejects.toThrow('db down');
      expect(stored().availableDays).toBe('everyday');

      await expect(service.update('g-1', { availableDays: 'weekends' })).resolves.toMatchObject({ slotSync: { removed: 1 } });
      expect(stored().availableDays).toBe('weekends');
      expect(slots.resync).toHaveBeenCalledTimes(2);
      expect(prisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function), { timeout: 20_000 });
    });
  });
});

describe('peak pricing rules', () => {
  const peak = { peakPrice: 2500, peakRanges: [{ fromHour: 17, toHour: 22 }] };

  it('saves peak pricing on create', async () => {
    const { service, prisma } = setup();
    await service.create({ ...newGround, ...peak });
    expect(prisma.ground.create.mock.calls[0]![0].data).toMatchObject(peak);
  });

  it.each([
    ['a price without ranges', { peakPrice: 2500, peakRanges: [] }],
    ['ranges without a price', { peakPrice: null, peakRanges: [{ fromHour: 17, toHour: 20 }] }],
    ['a range outside opening hours', { peakPrice: 2500, peakRanges: [{ fromHour: 5, toHour: 8 }] }],
    ['overlapping ranges', { peakPrice: 2500, peakRanges: [{ fromHour: 17, toHour: 20 }, { fromHour: 19, toHour: 22 }] }],
  ])('rejects %s', async (_label, input) => {
    await expectAppError(setup().service.create({ ...newGround, ...input }), 400, 'INVALID_PEAK_PRICING');
  });

  it('rechecks stored ranges when the hours shrink', async () => {
    const { service } = setup(ground({ ...peak }));
    await expectAppError(service.update('g-1', { closingHour: 20 }), 400, 'INVALID_PEAK_PRICING');
  });

  it('clears peak pricing when both are reset', async () => {
    const { service } = setup(ground({ ...peak }));
    await expect(service.update('g-1', { peakPrice: null, peakRanges: [] })).resolves.toMatchObject({ peakPrice: null });
  });
});

describe('ground schemas', () => {
  const valid = { name: 'Arena', sport: 'football', hourlyPrice: 1500, openingHour: 6, closingHour: 22 };

  it.each(['4x4', '8x8', '9x9', '11x11'])('accepts the %s format', (format) => {
    expect(CreateGroundSchema.safeParse({ ...valid, format }).success).toBe(true);
  });

  it('accepts the minimum and fills defaults', () => {
    expect(CreateGroundSchema.parse(valid)).toMatchObject({ isActive: true, showOnPortal: true, amenities: [] });
  });

  it.each([
    ['a missing sport', { sport: undefined }, 'sport'],
    ['an unknown sport', { sport: 'golf' }, 'sport'],
    ['an unknown format', { format: '10x10' }, 'format'],
    ['an unknown amenity', { amenities: ['Pool'] }, 'amenities.0'],
    ['repeated amenities', { amenities: ['AC', 'AC'] }, 'amenities'],
    ['repeated days', { customDays: ['mon', 'mon'] }, 'customDays'],
    ['a zero capacity', { capacity: 0 }, 'capacity'],
    ['too-long dimensions', { dimensions: 'x'.repeat(51) }, 'dimensions'],
    ['closing before opening', { openingHour: 22, closingHour: 6 }, 'closingHour'],
    ['a fractional price', { hourlyPrice: 15.5 }, 'hourlyPrice'],
    ['a 90-minute slot', { slotDurationMinutes: 90 }, 'slotDurationMinutes'],
    ['a peak range ending before it starts', { peakRanges: [{ fromHour: 20, toHour: 18 }] }, 'peakRanges.0.toHour'],
  ])('rejects %s', (_label, change, field) => {
    const result = CreateGroundSchema.safeParse({ ...valid, ...change });
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain(field);
  });

  it.each(['', '   ', ' \n '])('stores blank rules (%j) as null', (rules) => {
    expect(UpdateGroundSchema.parse({ rules })).toEqual({ rules: null });
    expect(CreateGroundSchema.parse({ ...valid, rules }).rules).toBeNull();
  });

  it('keeps written rules and null, and leaves out rules that were not sent', () => {
    expect(UpdateGroundSchema.parse({ rules: '  No studs.\nArrive early.  ' })).toEqual({ rules: 'No studs.\nArrive early.' });
    expect(UpdateGroundSchema.parse({ rules: null })).toEqual({ rules: null });
    expect(UpdateGroundSchema.parse({ name: 'Arena' })).not.toHaveProperty('rules');
    expect(CreateGroundSchema.parse(valid)).not.toHaveProperty('rules');
  });

  it('rejects an empty update', () => {
    expect(UpdateGroundSchema.safeParse({}).success).toBe(false);
  });
});
