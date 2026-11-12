import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { env } from '../src/config/env.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { toDbDate } from '../src/slots/venue-time.js';

const run = promisify(execFile);
const PREFIX = 'E2E BookingSlot Rollout';

describe('BookingSlot cut-over repair (e2e)', () => {
  let prisma: PrismaService;
  let groundId: string;
  let customerId: string;

  beforeAll(async () => {
    if (env.NODE_ENV !== 'test') throw new Error('Rollout tests require the isolated test database');
    prisma = new PrismaService();
    groundId = (await prisma.ground.create({ data: { name: PREFIX, sport: 'football', hourlyPrice: 1000, openingHour: 8, closingHour: 22 } })).id;
    customerId = (await prisma.customer.create({ data: { name: PREFIX } })).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    if (groundId) {
      await prisma.bookingSlot.deleteMany({ where: { booking: { groundId } } });
      await prisma.booking.deleteMany({ where: { groundId } });
      await prisma.slot.deleteMany({ where: { groundId } });
      await prisma.ground.delete({ where: { id: groundId } });
    }
    if (customerId) await prisma.customer.delete({ where: { id: customerId } });
    await prisma.$disconnect();
  });

  it('repairs stale indexes before backfilling a rebooking, includes cancelled legacy bookings and is repeatable', async () => {
    const makeSlot = (startHour: number) => prisma.slot.create({
      data: { groundId, date: toDbDate('2099-11-12'), startHour, price: 1000, status: 'booked' },
    });
    const first = await makeSlot(18);
    const second = await makeSlot(19);
    const makeBooking = (slotId: string, cancelled = false) => prisma.booking.create({
      data: {
        bookingNumber: `ROLLOUT-${randomUUID()}`, source: 'staff', groundId, slotId,
        liveSlotId: cancelled ? null : slotId, customerId, contactName: PREFIX, contactPhone: '+8801700000099',
        amount: 1000, total: 1000, status: cancelled ? 'cancelled' : 'pending',
        cancelledAt: cancelled ? new Date('2026-11-12T00:00:00Z') : null,
      },
    });
    const old = await makeBooking(first.id);
    await prisma.bookingSlot.create({ data: { bookingId: old.id, slotId: first.id, liveSlotId: first.id, price: 1000 } });
    // Simulate an old instance cancelling and rebooking without touching BookingSlot.
    await prisma.booking.update({ where: { id: old.id }, data: { status: 'cancelled', liveSlotId: null } });
    const replacement = await makeBooking(first.id);
    const cancelled = await makeBooking(second.id, true);

    const reconcile = () => run(process.execPath, [
      'node_modules/prisma/build/index.js', 'db', 'execute', '--file', 'prisma/rollouts/booking-slots.sql',
    ], { env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: env.DATABASE_URL } });
    await reconcile();
    await reconcile();

    const rows = await prisma.bookingSlot.findMany({ where: { booking: { groundId } } });
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.bookingId === old.id)).toMatchObject({ liveSlotId: null, cancelledAt: expect.any(Date) });
    expect(rows.find((r) => r.bookingId === replacement.id)).toMatchObject({ slotId: first.id, liveSlotId: first.id, price: 1000, cancelledAt: null });
    expect(rows.find((r) => r.bookingId === cancelled.id)).toMatchObject({ liveSlotId: null, cancelledAt: cancelled.cancelledAt });
  });
});
