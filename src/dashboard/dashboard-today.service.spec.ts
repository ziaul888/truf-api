import type { Closure } from '../generated/prisma/client.js';
import type { MoneyEvent } from '../reports/report-data.js';
import { groundToday } from './dashboard-today.service.js';

const ground = { id: 'g-1', name: 'Arena', sport: 'football' as const, format: '5x5', openingHour: 16, closingHour: 21 };
const booking = (id: string, total = 1000, paid = 0) => ({
  id, bookingNumber: `CT-${id}`, contactName: `Customer ${id}`, status: 'confirmed' as const, total,
  payments: paid ? [{ amount: paid, status: 'succeeded' as const }] : [],
});
const slot = (startHour: number, status: 'available' | 'held' | 'booked' | 'blocked', b?: ReturnType<typeof booking>, closureId: string | null = null) => ({
  groundId: 'g-1', startHour, durationMinutes: 60, status, closureId, bookings: b ? [b] : [],
});
const SLOTS = [slot(16, 'available'), slot(17, 'booked', booking('A')), slot(18, 'available'), slot(19, 'booked', booking('B', 1000, 400)), slot(20, 'blocked')];
const at = (hour: number, minute: number) => ({ date: '2026-10-31', minutes: hour * 60 + minute });
const money: MoneyEvent[] = [
  { date: '2026-10-31', kind: 'received', amount: 400, method: 'cash', groundId: 'g-1' },
  { date: '2026-10-31', kind: 'received', amount: 999, method: 'cash', groundId: 'other' },
];

describe('groundToday', () => {
  it('counts slots, hours and revenue, and finds who is on now and next', () => {
    const day = groundToday(ground, SLOTS, [], money, at(17, 59));
    expect(day).toMatchObject({
      closedReason: null,
      slots: { total: 5, available: 2, held: 0, booked: 2, blocked: 1 },
      bookedHours: 2, remainingFreeHours: 1, revenueToday: 400,
      current: { bookingId: 'A', bookingNumber: 'CT-A', customerName: 'Customer A', startHour: 17, endHour: 18 },
      next: { bookingId: 'B', startHour: 19, due: 600 },
    });
    expect(day.timeline[1]).toEqual({ startHour: 17, endHour: 18, status: 'booked' });
  });

  it('a 17–18 slot is over at 18:00 sharp', () => {
    expect(groundToday(ground, SLOTS, [], [], at(18, 0)).current).toBeNull();
    expect(groundToday(ground, SLOTS, [], [], at(19, 30)).current?.bookingId).toBe('B');
    expect(groundToday(ground, SLOTS, [], [], at(19, 30)).next).toBeNull();
  });

  it('a ground closed today shows the closure label and hides the closure blocks', () => {
    const eid = { id: 'cl-1', groundIds: [], publicLabel: 'Closed for Eid' } as unknown as Closure;
    const blocked = [slot(16, 'blocked', undefined, 'cl-1'), slot(17, 'blocked', undefined, 'cl-1')];
    expect(groundToday(ground, blocked, [eid], [], at(10, 0))).toMatchObject({ closedReason: 'Closed for Eid', slots: { total: 0 }, timeline: [] });
  });

  it('a ground with no slots today is "Not open today"', () => {
    expect(groundToday(ground, [], [], [], at(10, 0))).toMatchObject({ closedReason: 'Not open today', slots: { total: 0 } });
  });
});
