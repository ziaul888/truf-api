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
  address: null,
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
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
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
    expect(slots.resync).toHaveBeenCalledWith('g-1');
  });

  it('leaves slots alone for other edits', async () => {
    const { service, slots } = setup();
    const dto = await service.update('g-1', { name: 'Renamed' });
    expect(slots.resync).not.toHaveBeenCalled();
    expect(dto).not.toHaveProperty('slotSync');
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

  it('rejects an empty update', () => {
    expect(UpdateGroundSchema.safeParse({}).success).toBe(false);
  });
});
