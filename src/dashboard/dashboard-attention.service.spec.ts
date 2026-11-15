import type { PrismaService } from '../prisma/prisma.service.js';
import { DashboardAttentionService } from './dashboard-attention.service.js';

function setup(refundDue: number) {
  const prisma = {
    booking: {
      findMany: vi.fn(async (): Promise<object[]> => []),
      // Which count is which is told apart by its filter: wallets under review vs refunds still to send.
      count: vi.fn(async ({ where }: { where: { status?: string } }) => (where.status === 'cancelled' ? refundDue : 0)),
      groupBy: vi.fn(async () => []),
    },
    slot: { findMany: vi.fn(async () => []) },
  };
  return { service: new DashboardAttentionService(prisma as unknown as PrismaService), prisma };
}

describe('DashboardAttentionService', () => {
  it('counts cancelled bookings with a bKash / Nagad refund still to send, as an extra field', async () => {
    const { service, prisma } = setup(3);
    const attention = await service.attention();
    expect(attention.refundDue).toEqual({ count: 3 });
    expect(attention).toHaveProperty('toConfirm');
    expect(attention).toHaveProperty('needsOutcome');
    expect(prisma.booking.count).toHaveBeenCalledWith({
      where: {
        deletedAt: null, status: 'cancelled',
        payments: { some: { deletedAt: null, status: 'refunded', method: { in: ['bkash', 'nagad'] }, refundSentAt: null } },
      },
    });
  });
});
