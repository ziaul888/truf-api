import type { PrismaService } from '../prisma/prisma.service.js';
import { loadNeedsOutcome, NEEDS_OUTCOME_LIMIT } from './needs-outcome.js';

// 10:00 on 28 Oct 2026, venue time.
const now = { date: '2026-10-28', minutes: 600 } as never;
const day = (date: string) => new Date(`${date}T00:00:00Z`);

const row = (id: string, date: string, startHour: number, overrides: object = {}) => ({
  id, bookingNumber: `CT-${id}`, contactName: 'Rakib', status: 'pending', total: 1000, payAtVenue: true,
  ground: { name: 'Main' }, slot: { date: day(date), startHour, startMinute: 0, durationMinutes: 60 }, payments: [], bookingSlots: [], ...overrides,
});

function setup(rows: object[]) {
  const findMany = vi.fn(async (_args: { where: object; orderBy: object }) => rows);
  return { prisma: { booking: { findMany } } as unknown as PrismaService, findMany };
}

describe('loadNeedsOutcome', () => {
  it('asks for live pending bookings up to today, newest slot first, without card checkouts', async () => {
    const { prisma, findMany } = setup([]);
    await loadNeedsOutcome(prisma, now);
    const args = findMany.mock.calls[0]![0];
    expect(args.where).toMatchObject({ deletedAt: null, status: 'pending', NOT: expect.objectContaining({ source: 'portal', payAtVenue: false }) });
    expect(args.orderBy).toEqual([{ slot: { date: 'desc' } }, { slot: { startHour: 'desc' } }, { slot: { startMinute: 'desc' } }]);
  });

  it('keeps only slots that have ended, with what the card needs', async () => {
    const { prisma } = setup([
      row('A', '2026-10-28', 9), // 09:00–10:00: ended at 10:00
      row('B', '2026-10-28', 9, { slot: { date: day('2026-10-28'), startHour: 9, startMinute: 0, durationMinutes: 120 } }), // still on
      row('C', '2026-10-27', 20, { payAtVenue: false, payments: [{ amount: 1200, status: 'pending', method: 'bkash', payerNumber: '+8801811000000' }] }),
    ]);
    const result = await loadNeedsOutcome(prisma, now);
    expect(result.count).toBe(2);
    expect(result.bookings[0]).toEqual({
      id: 'A', bookingNumber: 'CT-A', customerName: 'Rakib', groundName: 'Main', slot: {
        date: '2026-10-28', startHour: 9, startMinute: 0, endHour: 10, endMinute: 0, startTime: '09:00', endTime: '10:00',
      },
      slots: [{ date: '2026-10-28', startHour: 9, startMinute: 0, endHour: 10, endMinute: 0, startTime: '09:00', endTime: '10:00' }],
      total: 1000, paid: 0, due: 1000, payAtVenue: true, walletPayment: null,
    });
    // Under review: not money owed; the card says Verify.
    expect(result.bookings[1]).toMatchObject({ id: 'C', due: 0, walletPayment: { method: 'bkash', status: 'pending' } });
  });

  it('is over only once the last slot has ended, and shows the whole booked span', async () => {
    const live = (startHour: number) => ({ price: 1500, cancelledAt: null, slot: { id: `s-${startHour}`, date: day('2026-10-28'), startHour, startMinute: 0, durationMinutes: 60 } });
    const { prisma } = setup([
      row('D', '2026-10-28', 7, { bookingSlots: [live(7), live(8)] }), // 07:00–09:00: over
      row('E', '2026-10-28', 8, { bookingSlots: [live(8), live(10)] }), // last slot runs until 11:00
    ]);
    const result = await loadNeedsOutcome(prisma, now);
    expect(result.count).toBe(1);
    expect(result.bookings[0]).toMatchObject({ id: 'D', slot: { date: '2026-10-28', startTime: '07:00', endTime: '09:00' } });
  });

  it('lists at most the limit but counts them all', async () => {
    const rows = Array.from({ length: NEEDS_OUTCOME_LIMIT + 3 }, (_, i) => row(`R${i}`, '2026-10-20', 8));
    const result = await loadNeedsOutcome(setup(rows).prisma, now);
    expect(result.count).toBe(NEEDS_OUTCOME_LIMIT + 3);
    expect(result.bookings).toHaveLength(NEEDS_OUTCOME_LIMIT);
  });

  it('preserves nonconsecutive times and orders by the last slot end before applying the limit', async () => {
    const live = (startHour: number, startMinute = 0, durationMinutes = 60) => ({
      price: 1500, cancelledAt: null,
      slot: { id: `s-${startHour}`, date: day('2026-10-28'), startHour, startMinute, durationMinutes },
    });
    const { prisma } = setup([
      row('single', '2026-10-28', 8),
      row('gap', '2026-10-28', 6, { bookingSlots: [live(8, 30, 90), live(6)] }),
    ]);
    const result = await loadNeedsOutcome(prisma, now);
    expect(result.bookings.map((b) => b.id)).toEqual(['gap', 'single']);
    expect(result.bookings[0]!.slots).toMatchObject([
      { startTime: '06:00', endTime: '07:00' }, { startTime: '08:30', endTime: '10:00' },
    ]);
  });
});
