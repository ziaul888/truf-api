import type { PrismaService } from '../prisma/prisma.service.js';
import { CustomersService } from './customers.service.js';

const day = (date: string) => new Date(`${date}T00:00:00Z`);
const booking = (date: string, total: number, paid: number, status = 'confirmed', ground = { id: 'g-1', name: 'Arena' }) => ({
  id: `b-${date}-${total}`, bookingNumber: 'CT-AAAAA', status, total, dueDate: null, ground, slot: { date: day(date) },
  payments: paid ? [{ amount: paid, status: 'succeeded' }] : [],
});
const customer = (id: string, name: string, bookings: object[], createdAt = new Date('2026-01-01')) => ({
  id, name, email: `${id}@x.test`, phone: `+88017110000${id.slice(-2)}`, adminNote: null, createdAt, bookings,
});

const rows = [
  customer('c-01', 'Vip', Array.from({ length: 10 }, (_, i) => booking(`2026-10-${10 + i}`, 1000, 1000))),
  customer('c-02', 'Owes', [booking('2026-10-20', 1000, 400), booking('2026-10-21', 1000, 0, 'cancelled')]),
  customer('c-03', 'New', []),
];

function setup() {
  const prisma = {
    customer: { findMany: vi.fn(async () => rows), findFirst: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null) },
    booking: { findMany: vi.fn(async () => []) },
  };
  return new CustomersService(prisma as unknown as PrismaService);
}

describe('CustomersService', () => {
  it('computes totals, dues and tags; cancelled bookings neither count nor owe', async () => {
    const { data, stats } = await setup().list({ page: 1, limit: 20, sort: 'totalSpent' });
    expect(data.map((c) => [c.name, c.bookings, c.totalSpent, c.dueAmount, c.tag])).toEqual([
      ['Vip', 10, 10000, 0, 'vip'],
      ['Owes', 1, 400, 600, 'new'],
      ['New', 0, 0, 0, 'new'],
    ]);
    expect(stats).toMatchObject({ total: 3, withDuePayments: 1, totalDueAmount: 600, totalRevenue: 10400 });
  });

  it('filters by tag, due and search, and paginates', async () => {
    const service = setup();
    expect((await service.list({ page: 1, limit: 20, sort: 'lastBooking', tag: 'vip' })).data.map((c) => c.name)).toEqual(['Vip']);
    expect((await service.list({ page: 1, limit: 20, sort: 'lastBooking', hasDue: true })).data.map((c) => c.name)).toEqual(['Owes']);
    expect((await service.list({ page: 1, limit: 20, sort: 'lastBooking', search: 'owe' })).total).toBe(1);
    expect((await service.list({ page: 2, limit: 2, sort: 'lastBooking' })).data).toHaveLength(1);
  });

  it('returns dues and the favourite ground on the detail', async () => {
    const detail = await setup().get('c-02');
    expect(detail.duePayments).toEqual([expect.objectContaining({ amount: 600 })]);
    expect(detail.favoriteGround).toEqual({ id: 'g-1', name: 'Arena', bookings: 1 });
  });

  it('404s for an unknown customer', async () => {
    await expect(setup().get('nope')).rejects.toMatchObject({ status: 404, code: 'CUSTOMER_NOT_FOUND' });
  });
});
