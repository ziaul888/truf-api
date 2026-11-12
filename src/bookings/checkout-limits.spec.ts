import type { PrismaService } from '../prisma/prisma.service.js';
import { venueNow } from '../slots/venue-time.js';
import { WALLET_UNDER_REVIEW } from './booking-rules.js';
import { hasUpcomingSlot } from './booking-slots.js';
import { assertCanBookUnpaid, MAX_OPEN_UNPAID } from './checkout-limits.js';

// 04:00 UTC = 10:00 in Dhaka, Wed 28 Oct 2026.
const NOW = new Date('2026-10-28T04:00:00Z');
const PHONE = '+8801711000000';

function setup(open = 0) {
  const count = vi.fn(async (_args: { where: object }) => open);
  return { prisma: { booking: { count } } as unknown as PrismaService, count };
}

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

describe('assertCanBookUnpaid', () => {
  it('leaves card checkouts alone, signed in or not, and counts nothing', async () => {
    const { prisma, count } = setup(MAX_OPEN_UNPAID);
    await expect(assertCanBookUnpaid(prisma, 'card', undefined)).resolves.toBeUndefined();
    await expect(assertCanBookUnpaid(prisma, 'card', PHONE)).resolves.toBeUndefined();
    expect(count).not.toHaveBeenCalled();
  });

  it.each(['cash', 'bkash', 'nagad'] as const)('needs a signed-in customer for %s: 401 SIGN_IN_REQUIRED', async (method) => {
    const { prisma, count } = setup();
    await expect(assertCanBookUnpaid(prisma, method, undefined)).rejects.toMatchObject({ status: 401, code: 'SIGN_IN_REQUIRED' });
    expect(count).not.toHaveBeenCalled();
  });

  it('allows up to 3 open unpaid bookings per phone, then 409 TOO_MANY_OPEN_BOOKINGS', async () => {
    await expect(assertCanBookUnpaid(setup(MAX_OPEN_UNPAID - 1).prisma, 'cash', PHONE)).resolves.toBeUndefined();
    await expect(assertCanBookUnpaid(setup(MAX_OPEN_UNPAID).prisma, 'bkash', PHONE))
      .rejects.toMatchObject({ status: 409, code: 'TOO_MANY_OPEN_BOOKINGS' });
  });

  it('counts only pending portal cash or wallet-under-review bookings on the phone whose slot is still ahead', async () => {
    const { prisma, count } = setup();
    await assertCanBookUnpaid(prisma, 'nagad', PHONE);
    // Card checkouts (payAtVenue false, no wallet payment) and slots already started are left out.
    expect(count).toHaveBeenCalledWith({
      where: {
        deletedAt: null, status: 'pending', source: 'portal', contactPhone: PHONE,
        // Any live slot still ahead counts (a multi-slot booking), not only the primary.
        AND: [hasUpcomingSlot(venueNow()), { OR: [{ payAtVenue: true }, WALLET_UNDER_REVIEW] }],
      },
    });
  });
});
