import { autoGroupBy, periodKeyOf, periodsOf, previousRange, trendOf, percent, venueDateOf } from './report-periods.js';

describe('report periods', () => {
  it('previous period is the same length immediately before', () => {
    expect(previousRange({ from: '2026-10-02', to: '2026-10-31' })).toEqual({ from: '2026-09-02', to: '2026-10-01' });
  });

  it('picks the grouping from the range length', () => {
    expect(autoGroupBy({ from: '2026-10-01', to: '2026-10-31' })).toBe('day');
    expect(autoGroupBy({ from: '2026-08-01', to: '2026-10-31' })).toBe('week');
    expect(autoGroupBy({ from: '2026-01-01', to: '2026-10-31' })).toBe('month');
  });

  it('days: every date, labelled "31 Oct"', () => {
    expect(periodsOf({ from: '2026-10-30', to: '2026-10-31' }, 'day')).toEqual([
      { period: '2026-10-30', end: '2026-10-30', label: '30 Oct' },
      { period: '2026-10-31', end: '2026-10-31', label: '31 Oct' },
    ]);
  });

  it('weeks start on Saturday and are clipped to the range', () => {
    // 2026-10-24 is a Saturday.
    expect(periodsOf({ from: '2026-10-22', to: '2026-11-02' }, 'week')).toEqual([
      { period: '2026-10-22', end: '2026-10-23', label: '22 – 23 Oct' },
      { period: '2026-10-24', end: '2026-10-30', label: '24 – 30 Oct' },
      { period: '2026-10-31', end: '2026-11-02', label: '31 Oct – 2 Nov' },
    ]);
    expect(periodKeyOf('2026-10-29', { from: '2026-10-22', to: '2026-11-02' }, 'week')).toBe('2026-10-24');
    expect(periodKeyOf('2026-10-23', { from: '2026-10-22', to: '2026-11-02' }, 'week')).toBe('2026-10-22');
  });

  it('months, across a year end', () => {
    expect(periodsOf({ from: '2026-12-15', to: '2027-01-10' }, 'month')).toEqual([
      { period: '2026-12-15', end: '2026-12-31', label: 'Dec 2026' },
      { period: '2027-01-01', end: '2027-01-10', label: 'Jan 2027' },
    ]);
  });

  it('trend and percent are null with nothing to compare', () => {
    expect(trendOf(110, 100)).toBe(10);
    expect(trendOf(5, 0)).toBeNull();
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(1, 0)).toBeNull();
  });

  it('dates instants in Dhaka time, not UTC', () => {
    // 00:30 on 1 Nov in Dhaka (UTC+6) is still 31 Oct in UTC.
    expect(venueDateOf(new Date('2026-10-31T18:30:00Z'))).toBe('2026-11-01');
  });
});
