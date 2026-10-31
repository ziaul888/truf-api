import type { PrismaService } from '../prisma/prisma.service.js';
import { DashboardService } from './dashboard.service.js';

function setup(customersNow: number, customersBefore: number) {
  const prisma = {
    payment: { aggregate: vi.fn(async () => ({ _sum: { amount: null } })) },
    booking: { count: vi.fn(async () => 0), groupBy: vi.fn(async () => []) },
    customer: { count: vi.fn().mockResolvedValueOnce(customersNow).mockResolvedValueOnce(customersBefore) },
    ground: { count: vi.fn(async () => 2) },
  };
  return new DashboardService(prisma as unknown as PrismaService);
}

describe('DashboardService.stats', () => {
  it('trends are null when last week was 0, not +100%', async () => {
    const stats = await setup(5, 0).stats();
    expect(stats).toMatchObject({ todayRevenueTrend: null, todayBookingsTrend: null, totalCustomersTrend: null, activeGroundsTrend: 0 });
  });

  it('trends are the % change otherwise', async () => {
    expect((await setup(5, 4).stats()).totalCustomersTrend).toBe(25);
  });
});
