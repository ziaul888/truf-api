import type { BookingSeries, Prisma, Slot } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { toDbDate } from '../slots/venue-time.js';
import { BookingSeriesBooker } from './booking-series-booker.js';

const now = { date: '2026-11-12', minutes: 600 };
const ground = { availableDays: 'everyday' as const, customDays: [] };
const createdAt = new Date('2026-11-12T00:00:00Z');
const series: BookingSeries = {
  id: 'series-1', groundId: 'ground-1', customerId: 'customer-1', contactName: 'Rakib',
  contactPhone: '+8801711000000', contactEmail: null, startHour: 18, startMinute: 30,
  weekdays: ['fri', 'sat'], fromDate: toDbDate('2026-11-13'), untilDate: null,
  status: 'active', bookedThrough: null, notes: null, createdById: 'user-1',
  stoppedAt: null, stoppedById: null, createdAt, updatedAt: createdAt, deletedAt: null,
};

const slot = (id: string, date: string, status: Slot['status'] = 'available'): Slot => ({
  id, groundId: series.groundId, date: toDbDate(date), startHour: 18, startMinute: 30,
  durationMinutes: 90, price: 1500, status, closureId: null, blockReason: null, blockNote: null,
  blockedById: null, blockedAt: null, heldUntil: null, heldByBookingId: null, createdAt, updatedAt: createdAt,
});

function setup(slots: Slot[], taken = slots.filter((s) => s.status === 'available')) {
  const tx = {
    slot: {
      findMany: vi.fn(async () => slots),
      updateManyAndReturn: vi.fn(async () => taken),
    },
    bookingSlot: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      createMany: vi.fn(async (_args: { data: Prisma.BookingSlotCreateManyInput[] }) => ({ count: 1 })),
    },
    booking: { createMany: vi.fn(async (_args: { data: Prisma.BookingCreateManyInput[] }) => ({ count: 1 })) },
    bookingEvent: { createMany: vi.fn(async () => ({ count: 2 })) },
    bookingSeriesSkip: { createMany: vi.fn(async (_args: { data: Prisma.BookingSeriesSkipCreateManyInput[] }) => ({ count: 0 })) },
  };
  const booker = new BookingSeriesBooker({} as PrismaService);
  const book = () => booker.book(tx as unknown as Prisma.TransactionClient, series, ground, ['2026-11-13', '2026-11-14'], 'user-1', now);
  return { tx, book };
}

describe('BookingSeriesBooker stale BookingSlot repair', () => {
  it('clears only stale indexes of cancelled bookings before claiming slots, then creates one row per repeat booking', async () => {
    const free = slot('free', '2026-11-13');
    const { tx, book } = setup([free, slot('busy', '2026-11-14', 'booked')]);
    const result = await book();
    expect(tx.bookingSlot.updateMany).toHaveBeenCalledWith({
      where: { slotId: { in: ['free'] }, liveSlotId: { not: null }, booking: { status: 'cancelled' } },
      data: { liveSlotId: null, cancelledAt: expect.any(Date) },
    });
    expect(tx.bookingSlot.updateMany.mock.invocationCallOrder[0]).toBeLessThan(tx.slot.updateManyAndReturn.mock.invocationCallOrder[0]!);
    expect(result).toEqual([{ id: expect.any(String), date: '2026-11-13', total: 1500 }]);
    const bookingId = result[0]!.id;
    expect(tx.booking.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({
      id: bookingId, seriesId: series.id, slotId: 'free', liveSlotId: 'free', amount: 1500, total: 1500, serviceFee: 0,
    })] });
    expect(tx.bookingSlot.createMany).toHaveBeenCalledWith({ data: [{ bookingId, slotId: 'free', liveSlotId: 'free', price: 1500 }] });
    expect(tx.bookingSeriesSkip.createMany).toHaveBeenCalledWith({
      data: [{ seriesId: series.id, date: toDbDate('2026-11-14'), reason: 'booked' }], skipDuplicates: true,
    });
  });

  it('does not clear indexes or claim inventory when every date is busy', async () => {
    const { tx, book } = setup([slot('booked', '2026-11-13', 'booked'), slot('held', '2026-11-14', 'held')]);
    expect(await book()).toEqual([]);
    expect(tx.bookingSlot.updateMany).not.toHaveBeenCalled();
    expect(tx.slot.updateManyAndReturn).not.toHaveBeenCalled();
    expect(tx.bookingSlot.createMany).toHaveBeenCalledWith({ data: [] });
  });

  it('records a lost claim as a skip and never writes a live BookingSlot for it', async () => {
    const first = slot('first', '2026-11-13');
    const { tx, book } = setup([first, slot('lost', '2026-11-14')], [first]);
    const result = await book();
    expect(result).toHaveLength(1);
    expect(tx.bookingSlot.createMany).toHaveBeenCalledWith({ data: [{ bookingId: result[0]!.id, slotId: 'first', liveSlotId: 'first', price: 1500 }] });
    expect(tx.bookingSeriesSkip.createMany).toHaveBeenCalledWith({
      data: [{ seriesId: series.id, date: toDbDate('2026-11-14'), reason: 'booked' }], skipDuplicates: true,
    });
  });

  it('propagates repair failures so the caller transaction cannot commit a partial booking', async () => {
    const { tx, book } = setup([slot('free', '2026-11-13')]);
    tx.bookingSlot.updateMany.mockRejectedValueOnce(new Error('repair failed'));
    await expect(book()).rejects.toThrow('repair failed');
    expect(tx.slot.updateManyAndReturn).not.toHaveBeenCalled();
    expect(tx.booking.createMany).not.toHaveBeenCalled();
    expect(tx.bookingSlot.createMany).not.toHaveBeenCalled();
  });
});
