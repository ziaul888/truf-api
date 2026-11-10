import { hhmm, slotHour, slotTimes } from './slot-time.js';
import { hasEnded, hasStarted, minutesUntil } from './venue-time.js';

const at = (hour: number, minute: number) => ({ date: '2026-10-28', minutes: hour * 60 + minute });
const ninety = { startHour: 16, startMinute: 30, durationMinutes: 90 };

describe('slotTimes', () => {
  it('gives the start and end as hour, minute and "HH:MM"', () => {
    expect(slotTimes(ninety)).toEqual({ startHour: 16, startMinute: 30, endHour: 18, endMinute: 0, startTime: '16:30', endTime: '18:00' });
    expect(slotTimes({ startHour: 15, startMinute: 0, durationMinutes: 90 })).toMatchObject({ endHour: 16, endMinute: 30, endTime: '16:30' });
  });

  it('keeps 60 and 120 minute slots on the hour, and ends a midnight slot at 24:00', () => {
    expect(slotTimes({ startHour: 9, startMinute: 0, durationMinutes: 60 })).toEqual({
      startHour: 9, startMinute: 0, endHour: 10, endMinute: 0, startTime: '09:00', endTime: '10:00',
    });
    expect(slotTimes({ startHour: 22, startMinute: 0, durationMinutes: 120 })).toMatchObject({ endHour: 24, endMinute: 0, endTime: '24:00' });
    expect(slotTimes({ startHour: 22, startMinute: 30, durationMinutes: 90 })).toMatchObject({ endHour: 24, endMinute: 0, endTime: '24:00' });
    expect(hhmm(0)).toBe('00:00');
  });
});

describe('started, ended and the cutoff, to the minute', () => {
  it('a 16:30 slot starts at 16:30, not 16:00', () => {
    expect(slotHour(ninety)).toBe(16.5);
    expect(hasStarted(at(16, 10), '2026-10-28', slotHour(ninety))).toBe(false);
    expect(hasStarted(at(16, 29), '2026-10-28', slotHour(ninety))).toBe(false);
    expect(hasStarted(at(16, 30), '2026-10-28', slotHour(ninety))).toBe(true);
  });

  it('a 16:30–18:00 slot ends at 18:00', () => {
    expect(hasEnded(at(17, 59), '2026-10-28', slotHour(ninety), ninety.durationMinutes)).toBe(false);
    expect(hasEnded(at(18, 0), '2026-10-28', slotHour(ninety), ninety.durationMinutes)).toBe(true);
    expect(hasEnded(at(16, 59), '2026-10-28', slotHour({ startHour: 15, startMinute: 0 }), 90)).toBe(true);
  });

  it('counts the cutoff from the half hour', () => {
    // A 2-hour cutoff on 16:30 closes at 14:30.
    expect(minutesUntil(at(14, 29), '2026-10-28', slotHour(ninety))).toBe(121);
    expect(minutesUntil(at(14, 30), '2026-10-28', slotHour(ninety)) > 2 * 60).toBe(false);
    expect(minutesUntil(at(23, 0), '2026-10-29', slotHour({ startHour: 0, startMinute: 30 }))).toBe(90);
  });
});
