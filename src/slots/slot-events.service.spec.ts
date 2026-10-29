import type { PrismaService } from '../prisma/prisma.service.js';
import { SlotEventsService } from './slot-events.service.js';

const event = {
  id: 'e-1', slotId: 's-1', groundId: 'g-1', date: new Date('2026-10-29T00:00:00Z'), startHour: 18,
  action: 'block', reason: 'maintenance', note: 'Net', userId: 'u-1', createdAt: new Date('2026-10-28T05:00:00Z'),
  user: { id: 'u-1', name: 'Manager' }, ground: { name: 'Arena' },
};

function setup(slotExists = true) {
  const prisma = {
    slot: { findUnique: vi.fn(async () => (slotExists ? { id: 's-1' } : null)) },
    slotEvent: {
      findMany: vi.fn(async (_args: { where: object }) => [event]),
      count: vi.fn(async () => 1),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { service: new SlotEventsService(prisma as unknown as PrismaService), prisma };
}

describe('SlotEventsService', () => {
  it("returns a slot's history newest first", async () => {
    const { service, prisma } = setup();
    await expect(service.history('s-1')).resolves.toEqual([{
      id: 'e-1', action: 'block', reason: 'maintenance', note: 'Net', user: { id: 'u-1', name: 'Manager' }, createdAt: event.createdAt,
    }]);
    expect(prisma.slotEvent.findMany.mock.calls[0]![0]).toMatchObject({ where: { slotId: 's-1' }, orderBy: { createdAt: 'desc' } });
  });

  it('404s for an unknown slot', async () => {
    await expect(setup(false).service.history('x')).rejects.toMatchObject({ status: 404, code: 'SLOT_NOT_FOUND' });
  });

  it('lists the timeline with filters and where each event happened', async () => {
    const { service, prisma } = setup();
    const result = await service.list({ page: 1, limit: 20, groundId: 'g-1', from: '2026-10-01', to: '2026-10-31', action: 'block', userId: 'u-1' });

    expect(prisma.slotEvent.findMany.mock.calls[0]![0].where).toEqual({
      groundId: 'g-1', action: 'block', userId: 'u-1',
      date: { gte: new Date('2026-10-01T00:00:00Z'), lte: new Date('2026-10-31T00:00:00Z') },
    });
    expect(result).toMatchObject({ total: 1, data: [{ groundName: 'Arena', date: '2026-10-29', startHour: 18, slotId: 's-1' }] });
  });
});
