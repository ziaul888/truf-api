import { addDays, datesBetween, daysBetween, hasStarted, minutesUntil, venueNow, weekdayOf } from './venue-time.js';

describe('venue time', () => {
  it('reads the date and time in the venue timezone, not UTC', () => {
    // 20:30 UTC on 31 Dec is 02:30 on 1 Jan in Dhaka (UTC+6).
    expect(venueNow(new Date('2026-12-31T20:30:00Z'), 'Asia/Dhaka')).toEqual({ date: '2027-01-01', minutes: 150 });
  });

  it('does calendar maths on plain dates', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(daysBetween('2026-10-28', '2026-11-04')).toBe(7);
    expect(datesBetween('2026-10-30', '2026-11-01')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
    expect(weekdayOf('2026-10-28')).toBe('wed');
  });

  it('counts minutes until a slot starts, and treats the start minute as started', () => {
    const now = { date: '2026-10-28', minutes: 17 * 60 + 30 };
    expect(minutesUntil(now, '2026-10-28', 18)).toBe(30);
    expect(minutesUntil(now, '2026-10-29', 8)).toBe(870);
    expect(hasStarted(now, '2026-10-28', 17)).toBe(true);
    expect(hasStarted({ date: '2026-10-28', minutes: 18 * 60 }, '2026-10-28', 18)).toBe(true);
    expect(hasStarted(now, '2026-10-28', 18)).toBe(false);
  });
});
