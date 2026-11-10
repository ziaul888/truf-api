import { allocate, monthOf, monthRange, seriesDates, skipReasonOf, type SlotAtHour } from './booking-series-rules.js';

const everyday = { availableDays: 'everyday' as const, customDays: [] };
const now = { date: '2026-11-10', minutes: 12 * 60 };
const slot = (over: Partial<SlotAtHour> = {}): SlotAtHour => ({ startHour: 21, durationMinutes: 60, status: 'available', closureId: null, ...over });

describe('booking series rules', () => {
  it('matches only the chosen weekdays in the range, both ends included', () => {
    // 2026-11-10 is a Tuesday.
    expect(seriesDates('2026-11-10', '2026-11-24', ['tue', 'thu'])).toEqual(['2026-11-10', '2026-11-12', '2026-11-17', '2026-11-19', '2026-11-24']);
    expect(seriesDates('2026-11-11', '2026-11-11', ['tue'])).toEqual([]);
  });

  it('books a free upcoming slot and names why any other date is skipped', () => {
    expect(skipReasonOf(everyday, '2026-11-12', slot(), now)).toBeNull();
    expect(skipReasonOf(everyday, '2026-11-12', undefined, now)).toBe('no_slot');
    expect(skipReasonOf(everyday, '2026-11-12', slot({ status: 'booked' }), now)).toBe('booked');
    expect(skipReasonOf(everyday, '2026-11-12', slot({ status: 'held' }), now)).toBe('held');
    expect(skipReasonOf(everyday, '2026-11-12', slot({ status: 'blocked' }), now)).toBe('blocked');
    expect(skipReasonOf(everyday, '2026-11-12', slot({ status: 'blocked', closureId: 'c-1' }), now)).toBe('closed');
    expect(skipReasonOf(everyday, '2026-11-10', slot({ startHour: 9 }), now)).toBe('ended');
    // Started but not ended: still bookable, as for a walk-in.
    expect(skipReasonOf(everyday, '2026-11-10', slot({ startHour: 11, durationMinutes: 120 }), now)).toBeNull();
  });

  it('skips a day the ground does not open, whatever the slot says', () => {
    const weekdays = { availableDays: 'weekdays' as const, customDays: [] };
    // 2026-11-13 is a Friday (weekend).
    expect(skipReasonOf(weekdays, '2026-11-13', slot(), now)).toBe('closed');
  });

  it('allocates a payment earliest first, each booking filled up to its due', () => {
    const owing = [{ id: 'a', due: 1000 }, { id: 'b', due: 0 }, { id: 'c', due: 1000 }, { id: 'd', due: 1000 }];
    expect(allocate(2500, owing)).toEqual([{ id: 'a', amount: 1000 }, { id: 'c', amount: 1000 }, { id: 'd', amount: 500 }]);
    expect(allocate(400, owing)).toEqual([{ id: 'a', amount: 400 }]);
    expect(allocate(0, owing)).toEqual([]);
  });

  it('turns a month into its first and last day', () => {
    expect(monthRange('2026-11')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthOf('2026-11-24')).toBe('2026-11');
  });
});
