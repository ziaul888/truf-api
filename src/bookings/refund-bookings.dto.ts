import type { PaymentMethod } from '../generated/prisma/client.js';
import { isWalletMethod } from './booking-rules.js';
import {
  toBookingDto,
  type BookingDto,
  type BookingRow,
} from './booking.dto.js';
import type { RefundPayment } from './refund-tracking.js';

export interface RefundSummary {
  amount: number;
  /** Only refunded bKash/Nagad payments not yet marked sent. */
  dueAmount: number;
  methods: PaymentMethod[];
  /** "recorded" does not claim cash/bank transfers were sent automatically. */
  status: 'due' | 'recorded';
  refundedAt: string | null;
}

export interface RefundBookingDto extends BookingDto {
  refundSummary: RefundSummary;
}
type SummaryPayment = Pick<
  RefundPayment,
  'method' | 'status' | 'amount' | 'refundSentAt'
> & { refundedAt: Date | null };

/** Payments come from BOOKING_INCLUDE, which excludes soft-deleted rows. */
export function refundSummaryOf(payments: SummaryPayment[]): RefundSummary {
  const refunded = payments.filter((payment) => payment.status === 'refunded');
  const dueAmount = refunded
    .filter(
      (payment) =>
        isWalletMethod(payment.method) && payment.refundSentAt === null,
    )
    .reduce((sum, payment) => sum + payment.amount, 0);
  const latest = refunded.reduce<Date | null>(
    (date, payment) =>
      payment.refundedAt && (!date || payment.refundedAt > date)
        ? payment.refundedAt
        : date,
    null,
  );
  return {
    amount: refunded.reduce((sum, payment) => sum + payment.amount, 0),
    dueAmount,
    methods: [...new Set(refunded.map((payment) => payment.method))],
    status: dueAmount > 0 ? 'due' : 'recorded',
    refundedAt: latest?.toISOString() ?? null,
  };
}

export const toRefundBookingDto = (booking: BookingRow): RefundBookingDto => ({
  ...toBookingDto(booking),
  refundSummary: refundSummaryOf(booking.payments),
});
