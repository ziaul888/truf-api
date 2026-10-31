import { isDueToday, isOverdue, matchesDue, type OwingBooking } from './booking-due.js';

const now = { date: '2026-10-31', minutes: 17 * 60 };
const owing = (overrides: Partial<OwingBooking>): OwingBooking => ({ id: 'b', bookingNumber: 'CT-1', customerName: 'A', due: 500, dueDate: null, date: '2026-11-02', startHour: 18, ...overrides });

describe('money due', () => {
  it('is overdue after its due date', () => {
    expect(isOverdue(owing({ dueDate: '2026-10-30' }), now)).toBe(true);
    expect(isOverdue(owing({ dueDate: '2026-10-31' }), now)).toBe(false);
  });

  it('with no due date, is overdue once the slot has started', () => {
    expect(isOverdue(owing({ date: '2026-10-31', startHour: 17 }), now)).toBe(true);
    expect(isOverdue(owing({ date: '2026-10-31', startHour: 18 }), now)).toBe(false);
  });

  it('due today and the list filters', () => {
    const today = owing({ dueDate: '2026-10-31' });
    expect(isDueToday(today, now)).toBe(true);
    expect(matchesDue(today, 'today', now)).toBe(true);
    expect(matchesDue(today, 'overdue', now)).toBe(false);
    expect(matchesDue(owing({}), 'any', now)).toBe(true);
  });
});
