import { refundSummaryOf } from './refund-bookings.dto.js';

type Payment = Parameters<typeof refundSummaryOf>[0][number];
const earlier = new Date('2026-11-15T10:00:00Z');
const later = new Date('2026-11-16T10:00:00Z');
const payment = (overrides: Partial<Payment> = {}): Payment => ({
  status: 'refunded',
  method: 'bkash',
  amount: 1000,
  refundSentAt: null,
  refundedAt: earlier,
  ...overrides,
});

describe('refundSummaryOf', () => {
  it('sums all refund methods and excludes money that was never refunded', () => {
    const summary = refundSummaryOf([
      payment(),
      payment({ method: 'card', amount: 2000 }),
      payment({ method: 'cash', amount: 500 }),
      payment({ method: 'bank_transfer', amount: 750 }),
      payment({ status: 'succeeded', amount: 9999 }),
      payment({ status: 'pending', amount: 9999 }),
      payment({ status: 'failed', amount: 9999 }),
    ]);
    expect(summary).toMatchObject({
      amount: 4250,
      dueAmount: 1000,
      methods: ['bkash', 'card', 'cash', 'bank_transfer'],
      status: 'due',
    });
  });

  it('only counts unsent wallet refunds as due, including a partially sent booking', () => {
    const summary = refundSummaryOf([
      payment({ amount: 400, refundSentAt: later }),
      payment({ method: 'nagad', amount: 600 }),
      payment({ method: 'cash', amount: 300 }),
      payment({ method: 'card', amount: 200 }),
    ]);
    expect(summary).toMatchObject({
      amount: 1500,
      dueAmount: 600,
      status: 'due',
    });
  });

  it('does not claim an untracked cash or bank refund is still waiting for a wallet payout', () => {
    expect(
      refundSummaryOf([
        payment({ method: 'cash' }),
        payment({ method: 'bank_transfer' }),
      ]),
    ).toMatchObject({ amount: 2000, dueAmount: 0, status: 'recorded' });
    expect(refundSummaryOf([payment({ refundSentAt: later })])).toMatchObject({
      dueAmount: 0,
      status: 'recorded',
    });
  });

  it('uses the latest refund date even when payment creation order differs', () => {
    expect(
      refundSummaryOf([payment({ refundedAt: later }), payment()]).refundedAt,
    ).toBe(later.toISOString());
    expect(
      refundSummaryOf([payment({ refundedAt: null })]).refundedAt,
    ).toBeNull();
  });

  it('keeps an empty history at zero without inventing a refund date', () => {
    expect(refundSummaryOf([])).toEqual({
      amount: 0,
      dueAmount: 0,
      methods: [],
      status: 'recorded',
      refundedAt: null,
    });
  });
});
