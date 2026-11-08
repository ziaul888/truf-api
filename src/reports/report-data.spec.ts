import { bookingTotals, moneyTotals, type MoneyEvent, type ReportBooking } from './report-data.js';

const money = (kind: MoneyEvent['kind'], amount: number, method: MoneyEvent['method'] = 'card'): MoneyEvent =>
  ({ date: '2026-10-30', kind, amount, method, groundId: 'g-1' });
const booking = (status: ReportBooking['status'], total: number, ended = true): ReportBooking =>
  ({ date: '2026-10-30', status, total, groundId: 'g-1', hours: 1, ended });

describe('report totals', () => {
  it('revenue is received minus refunds, per method too', () => {
    expect(moneyTotals([money('received', 1000), money('received', 500, 'cash'), money('refund', 300)])).toEqual({
      received: 1500, refunds: 300, revenue: 1200, byMethod: { card: 700, cash: 500, bank_transfer: 0, bkash: 0, nagad: 0 },
    });
  });

  it('bKash and Nagad are their own methods', () => {
    const totals = moneyTotals([money('received', 6000, 'bkash'), money('received', 4000, 'nagad'), money('refund', 1000, 'nagad')]);
    expect(totals).toMatchObject({ received: 10000, refunds: 1000, revenue: 9000 });
    expect(totals.byMethod).toEqual({ card: 0, cash: 0, bank_transfer: 0, bkash: 6000, nagad: 3000 });
  });

  it('booking rates: average of kept bookings, completion of ended ones', () => {
    const totals = bookingTotals([
      booking('completed', 1000), booking('completed', 2000), booking('cancelled', 9999), booking('confirmed', 3000, false),
    ]);
    expect(totals).toEqual({
      bookings: 4, statusCounts: { pending: 0, confirmed: 1, completed: 2, cancelled: 1 },
      avgBookingValue: 2000, completionRate: 66.7, cancellationRate: 25,
    });
  });

  it('no bookings: zeros and a null completion rate', () => {
    expect(bookingTotals([])).toMatchObject({ bookings: 0, avgBookingValue: 0, completionRate: null, cancellationRate: 0 });
  });
});
