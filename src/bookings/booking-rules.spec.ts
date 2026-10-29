import { AppError } from '../common/app-error.js';
import {
  bookingToken, dueOf, isValidBookingToken, newBookingNumber, paidOf, paymentStatusOf, withBookingNumber,
} from './booking-rules.js';

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
});
