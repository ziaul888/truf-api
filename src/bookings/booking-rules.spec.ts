import { AppError } from '../common/app-error.js';
import {
  bookingToken, dueOf, isValidBookingToken, newBookingNumber, owedOf, paidOf, paymentStatusOf, pendingWalletPayment, withBookingNumber,
} from './booking-rules.js';
import { customerCanCancel, customerCanPay, customerCanRequestCancel, type BookingRow } from './booking.dto.js';

const clash = (index: string) =>
  Object.assign(new Error('unique'), { code: 'P2002', meta: { driverAdapterError: { cause: { constraint: { index } } } } });

describe('booking rules', () => {
  it('makes readable booking numbers without look-alike characters', () => {
    for (let i = 0; i < 50; i++) expect(newBookingNumber()).toMatch(/^CT-[A-HJKMNP-Z2-9]{5}$/);
  });

  it('retries a clashing booking number, and maps a live-slot clash to SLOT_NOT_AVAILABLE', async () => {
    const write = vi.fn().mockRejectedValueOnce(clash('Booking_bookingNumber_key')).mockResolvedValueOnce('ok');
    await expect(withBookingNumber(write)).resolves.toBe('ok');
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]![0]).not.toBe(write.mock.calls[1]![0]);

    const err = await withBookingNumber(() => Promise.reject(clash('Booking_liveSlotId_key'))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 409, code: 'SLOT_NOT_AVAILABLE' });
  });

  it('signs a link per booking that only matches that booking', () => {
    const token = bookingToken('b-1');
    expect(isValidBookingToken('b-1', token)).toBe(true);
    expect(isValidBookingToken('b-2', token)).toBe(false);
    expect(isValidBookingToken('b-1', undefined)).toBe(false);
    expect(isValidBookingToken('b-1', `${token}x`)).toBe(false);
  });

  it('counts only successful payments as paid', () => {
    const payments = [
      { amount: 400, status: 'succeeded' as const },
      { amount: 300, status: 'refunded' as const },
      { amount: 100, status: 'failed' as const },
    ];
    expect(paidOf(payments)).toBe(400);
    expect(dueOf({ status: 'confirmed', total: 1000 }, payments)).toBe(600);
    expect(dueOf({ status: 'cancelled', total: 1000 }, payments)).toBe(0);
  });

  it.each([
    [[{ amount: 1000, status: 'succeeded' }], 'paid'],
    [[{ amount: 400, status: 'succeeded' }], 'partial'],
    [[{ amount: 1000, status: 'refunded' }], 'refunded'],
    [[{ amount: 1000, status: 'failed' }], 'failed'],
    [[], 'unpaid'],
  ] as const)('payment status of %j is %s', (payments, expected) => {
    expect(paymentStatusOf(1000, [...payments])).toBe(expected);
  });

  it('a duplicate TrxID while booking is 409 REFERENCE_ALREADY_USED', async () => {
    await expect(withBookingNumber(async () => { throw clash('Payment_method_reference_key'); }))
      .rejects.toMatchObject({ status: 409, code: 'REFERENCE_ALREADY_USED' });
  });

  describe('bKash / Nagad awaiting verification', () => {
    const wallet = (status: 'pending' | 'succeeded') => ({ method: 'bkash' as const, amount: 6000, status });
    const row = (overrides: object) => ({ status: 'pending', source: 'portal', payAtVenue: false, total: 6000, payments: [], ...overrides }) as unknown as BookingRow;

    it('finds only a pending wallet payment', () => {
      expect(pendingWalletPayment([wallet('pending')])).toMatchObject({ method: 'bkash' });
      expect(pendingWalletPayment([wallet('succeeded'), { method: 'cash', amount: 1, status: 'pending' }])).toBeUndefined();
    });

    it('is not money owed, and can only be asked to cancel (once, outside the cutoff)', () => {
      const now = { date: '2026-10-28', minutes: 600 } as never;
      const slot = { date: new Date('2026-10-29T00:00:00Z'), startHour: 18 };
      const review = row({ payments: [wallet('pending')], slot, cancelRequestedAt: null });
      expect(owedOf(review, review.payments)).toBe(0);
      expect(owedOf(row({ payments: [] }), [])).toBe(6000);
      expect(customerCanCancel(review, now, 2)).toBe(false);
      expect(customerCanRequestCancel(review, now, 2)).toBe(true);
      expect(customerCanRequestCancel(row({ ...review, cancelRequestedAt: new Date() }), now, 2)).toBe(false);
      expect(customerCanRequestCancel(review, now, 40)).toBe(false);
    });

    it('offers no "Pay now" while the venue verifies, but does for the rest after a bKash advance', () => {
      expect(customerCanPay(row({ payments: [wallet('pending')] }))).toBe(false);
      expect(customerCanPay(row({ status: 'confirmed', source: 'staff', payments: [{ ...wallet('succeeded'), amount: 2000 }] }))).toBe(true);
    });
  });
});
