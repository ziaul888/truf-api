import type {
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '../generated/prisma/client.js';
import {
  WALLET_METHODS,
  isWalletMethod,
  type WalletMethod,
} from './booking-rules.js';

/** A refunded bKash / Nagad payment: the money goes back by hand, so staff record when they sent it. */
export const WALLET_REFUND: Prisma.PaymentWhereInput = {
  deletedAt: null,
  status: 'refunded',
  method: { in: [...WALLET_METHODS] },
};

/** Those refunds that staff have not yet recorded as sent. */
export const REFUND_DUE: Prisma.PaymentWhereInput = {
  ...WALLET_REFUND,
  refundSentAt: null,
};

/** Cancelled bookings with a manual refund still to send (dashboard card, `refundDue=true` list filter). */
export const REFUND_DUE_BOOKING: Prisma.BookingWhereInput = {
  status: 'cancelled',
  payments: { some: REFUND_DUE },
};

/** What the dashboard shows staff for a manual refund. */
export interface RefundDto {
  /** Sum of the booking's refunded bKash / Nagad payments. */
  amount: number;
  /** From the latest of those payments. */
  method: WalletMethod;
  /** The number the customer paid from (latest payment); null when staff recorded the payment. */
  payerNumber: string | null;
  /** ISO time; set only when every one of those payments is sent, else null (still due). */
  sentAt: string | null;
  sentBy: string | null;
  note: string | null;
}

export interface RefundPayment {
  method: PaymentMethod;
  status: PaymentStatus;
  amount: number;
  payerNumber: string | null;
  refundSentAt: Date | null;
  refundNote: string | null;
  refundSentBy: { name: string } | null;
}

/** The booking's manual refund, or null when it has no refunded bKash / Nagad payment. `payments` are oldest first. */
export function refundOf(payments: RefundPayment[]): RefundDto | null {
  const refunded = payments.filter(
    (p) => p.status === 'refunded' && isWalletMethod(p.method),
  );
  const latest = refunded.at(-1);
  if (!latest || !isWalletMethod(latest.method)) return null;
  const allSent = refunded.every((p) => p.refundSentAt !== null);
  const sent = allSent ? latest : undefined;
  return {
    amount: refunded.reduce((sum, p) => sum + p.amount, 0),
    method: latest.method,
    payerNumber: latest.payerNumber,
    sentAt: sent?.refundSentAt?.toISOString() ?? null,
    sentBy: sent?.refundSentBy?.name ?? null,
    note: sent?.refundNote ?? null,
  };
}
