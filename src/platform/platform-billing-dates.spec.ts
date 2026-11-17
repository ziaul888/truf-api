import {
  billingPeriod,
  billingDate,
  billingToday,
  subscriptionState,
} from './platform-billing-dates.js';
const date = (value: string) => new Date(value + 'T00:00:00Z');
describe('platform calendar billing', () => {
  it.each([
    ['2026-01-31', 'monthly', 0, '2026-01-31', '2026-02-28'],
    ['2026-01-31', 'monthly', 1, '2026-02-28', '2026-03-31'],
    ['2024-01-31', 'monthly', 1, '2024-02-29', '2024-03-31'],
    ['2026-08-31', 'monthly', 1, '2026-09-30', '2026-10-31'],
    ['2024-02-29', 'yearly', 0, '2024-02-29', '2025-02-28'],
    ['2024-02-29', 'yearly', 3, '2027-02-28', '2028-02-29'],
    ['2096-02-29', 'yearly', 3, '2099-02-28', '2100-02-28'],
  ] as const)(
    'keeps the anchor for %s %s period %i',
    (anchor, interval, index, start, end) => {
      const period = billingPeriod(date(anchor), interval, index);
      expect(billingDate(period.start)).toBe(start);
      expect(billingDate(period.end)).toBe(end);
    },
  );
  it('uses Bangladesh calendar dates independently of the server time zone', () => {
    expect(billingDate(billingToday(new Date('2026-11-16T17:59:59Z')))).toBe(
      '2026-11-16',
    );
    expect(billingDate(billingToday(new Date('2026-11-16T18:00:00Z')))).toBe(
      '2026-11-17',
    );
  });
  const base = {
    status: 'active' as const,
    anchorDate: date('2026-10-17'),
    paidThrough: date('2026-11-17'),
    cancelAtPeriodEnd: false,
  };
  it('expires a paid period without waiting for a background job', () => {
    expect(subscriptionState(base, date('2026-11-16'))).toBe('active');
    expect(subscriptionState(base, date('2026-11-17'))).toBe('past_due');
  });
  it('preserves paid access until the end after cancellation', () => {
    expect(
      subscriptionState(
        { ...base, cancelAtPeriodEnd: true },
        date('2026-11-16'),
      ),
    ).toBe('active');
    expect(
      subscriptionState(
        { ...base, cancelAtPeriodEnd: true },
        date('2026-11-17'),
      ),
    ).toBe('cancelled');
  });
  it('does not grant early access for a prepaid future start', () => {
    expect(
      subscriptionState(
        {
          ...base,
          anchorDate: date('2026-12-17'),
          paidThrough: date('2027-01-17'),
        },
        date('2026-11-17'),
      ),
    ).toBe('scheduled');
  });
  it('keeps unpaid subscriptions pending', () => {
    expect(
      subscriptionState(
        { ...base, status: 'pending', paidThrough: null },
        date('2026-11-17'),
      ),
    ).toBe('pending');
  });
});
