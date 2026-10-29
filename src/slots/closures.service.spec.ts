import type { Slot } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ClosuresService } from './closures.service.js';

// 04:00 UTC = 10:00 in Dhaka, Wed 28 Oct 2026.
const NOW = new Date('2026-10-28T04:00:00Z');
const day = (date: string) => new Date(`${date}T00:00:00Z`);

const slot = (id: string, status: Slot['status'] = 'available') => ({ id, groundId: 'g-1', date: day('2026-11-01'), startHour: 18, status });
const closureRow = (overrides: object = {}) => ({
  id: 'c-1', fromDate: day('2026-11-01'), toDate: day('2026-11-02'), groundIds: [], reason: 'event', note: 'Eid',
  publicLabel: 'Closed for Eid', createdById: 'u-1', createdAt: NOW, liftedAt: null, liftedById: null,
  createdBy: { id: 'u-1', name: 'Admin' }, liftedBy: null, ...overrides,
});

function setup({ slots = [slot('a'), slot('b', 'booked')], closure = closureRow() as object | null, groundCount = 1 } = {}) {
  const tx = {
    closure: {
      create: vi.fn(async () => closureRow()),
      findUnique: vi.fn(async () => closure),
      update: vi.fn(async () => closure),
    },
    slot: {
      findMany: vi.fn(async (_args: { where: object }) => slots),
      updateMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => ({ count: where.id.in.length })),
    },
    slotEvent: { createMany: vi.fn(async (_args: { data: object[] }) => ({ count: 1 })) },
  };
  const prisma = {
    ground: { count: vi.fn(async () => groundCount) },
    closure: { findMany: vi.fn(async () => [closureRow()]) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { service: new ClosuresService(prisma as unknown as PrismaService), tx, prisma };
}

const input = { fromDate: '2026-11-01', toDate: '2026-11-02', reason: 'event' as const, note: 'Eid' };

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

describe('ClosuresService', () => {
  it('blocks free slots with the closure id, skips booked ones, and logs close events', async () => {
    const { service, tx } = setup();
    const result = await service.create('u-1', input);

    expect(result).toMatchObject({ blocked: 1, skippedBooked: 1, closure: { id: 'c-1', fromDate: '2026-11-01', groundIds: [] } });
    expect(tx.slot.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: { in: ['a'] }, status: 'available' },
      data: { status: 'blocked', closureId: 'c-1', blockReason: 'event' },
    });
    expect(tx.slotEvent.createMany.mock.calls[0]![0].data).toEqual([expect.objectContaining({ slotId: 'a', action: 'close' })]);
  });

  it('limits the slots to the chosen grounds', async () => {
    const { service, tx } = setup();
    await service.create('u-1', { ...input, groundIds: ['g-1'] });
    expect(tx.slot.findMany.mock.calls[0]![0].where).toMatchObject({ groundId: { in: ['g-1'] } });
  });

  it.each([
    ['a past start', { fromDate: '2026-10-27' }, 'INVALID_DATE_RANGE'],
    ['more than 31 days', { toDate: '2026-12-15' }, 'INVALID_DATE_RANGE'],
    ['an unknown ground', { groundIds: ['g-1', 'g-2'] }, 'GROUND_NOT_FOUND'],
  ])('rejects %s', async (_label, change, code) => {
    await expect(setup().service.create('u-1', { ...input, ...change })).rejects.toMatchObject({ code });
  });

  it('lifting frees only its own blocks and records who lifted it', async () => {
    const { service, tx } = setup({ slots: [slot('a', 'blocked')] });
    await expect(service.lift('u-2', 'c-1')).resolves.toEqual({ unblocked: 1 });
    expect(tx.slot.findMany.mock.calls[0]![0].where).toMatchObject({ closureId: 'c-1', status: 'blocked' });
    expect(tx.slotEvent.createMany.mock.calls[0]![0].data).toEqual([expect.objectContaining({ action: 'reopen', userId: 'u-2' })]);
    expect(tx.closure.update).toHaveBeenCalledWith({ where: { id: 'c-1' }, data: { liftedAt: expect.any(Date), liftedById: 'u-2' } });
  });

  it('refuses to lift twice, or an unknown closure', async () => {
    await expect(setup({ closure: closureRow({ liftedAt: NOW }) }).service.lift('u-1', 'c-1')).rejects.toMatchObject({ status: 409, code: 'CLOSURE_ALREADY_LIFTED' });
    await expect(setup({ closure: null }).service.lift('u-1', 'c-1')).rejects.toMatchObject({ status: 404, code: 'CLOSURE_NOT_FOUND' });
  });

  it('shows customers only dates and a label', async () => {
    const [closure] = await setup().service.listPublic({ from: '2026-11-01', to: '2026-11-30' });
    expect(closure).toEqual({ fromDate: '2026-11-01', toDate: '2026-11-02', groundIds: [], label: 'Closed for Eid' });
  });
});
