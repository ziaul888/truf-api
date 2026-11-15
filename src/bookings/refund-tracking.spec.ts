import { refundOf, type RefundPayment } from './refund-tracking.js';

const sent = new Date('2026-10-28T06:00:00Z');
const payment = (overrides: Partial<RefundPayment> = {}): RefundPayment => ({
  method: 'bkash', status: 'refunded', amount: 3000, payerNumber: '01711000000', refundSentAt: null, refundNote: null, refundSentBy: null, ...overrides,
});

describe('refundOf', () => {
  it.each([
    ['no payments', []],
    ['only cash and card refunds (paid back by other means)', [payment({ method: 'cash' }), payment({ method: 'card' })]],
    ['a bKash payment that was never refunded', [payment({ status: 'succeeded' }), payment({ status: 'failed' })]],
  ])('is null for %s', (_label, payments) => {
    expect(refundOf(payments)).toBeNull();
  });

  it('is still due while the refund is not sent', () => {
    expect(refundOf([payment()])).toEqual({ amount: 3000, method: 'bkash', payerNumber: '01711000000', sentAt: null, sentBy: null, note: null });
  });

  it('shows who sent it, when and the note', () => {
    const dto = refundOf([payment({ refundSentAt: sent, refundSentBy: { name: 'Manager' }, refundNote: 'TrxID 9BC4' })]);
    expect(dto).toMatchObject({ sentAt: '2026-10-28T06:00:00.000Z', sentBy: 'Manager', note: 'TrxID 9BC4' });
  });

  it('sums the refunded bKash / Nagad payments, takes the method and number from the latest, and ignores other methods', () => {
    const dto = refundOf([
      payment({ method: 'bkash', amount: 2000, payerNumber: '01711111111' }),
      payment({ method: 'cash', amount: 500 }),
      payment({ method: 'nagad', amount: 1500, payerNumber: '01822222222' }),
    ]);
    expect(dto).toMatchObject({ amount: 3500, method: 'nagad', payerNumber: '01822222222', sentAt: null });
  });

  it('is sent only when every payment is sent', () => {
    const one = payment({ amount: 2000, refundSentAt: sent, refundSentBy: { name: 'Manager' } });
    expect(refundOf([one, payment({ amount: 1000 })])?.sentAt).toBeNull();
    expect(refundOf([one, payment({ amount: 1000, refundSentAt: sent, refundSentBy: { name: 'Manager' } })])).toMatchObject({ amount: 3000, sentAt: sent.toISOString() });
  });

  it('has a null payer number for a payment staff recorded', () => {
    expect(refundOf([payment({ payerNumber: null })])?.payerNumber).toBeNull();
  });
});
