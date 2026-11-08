import { AppError } from '../common/app-error.js';
import type { PaymentStatus, Prisma } from '../generated/prisma/client.js';
import { bookingNotPending, paidOf, pendingWalletPayment, receivedDetail } from './booking-rules.js';
import type { BookingRow } from './booking.dto.js';

/**
 * "Verify": staff found the customer's bKash / Nagad money in their own app, so the pending payment
 * becomes received now (by them). Runs inside the confirm transaction. Refused when the booking is
 * already paid by other means (409, nothing changes), or when someone else handled the payment first.
 */
export async function verifyWalletPayment(
  tx: Prisma.TransactionClient, booking: BookingRow, actorId: string,
): Promise<{ amount: number; status: PaymentStatus }[]> {
  const wallet = pendingWalletPayment(booking.payments)!;
  if (paidOf(booking.payments) + wallet.amount > booking.total) {
    throw new AppError('Payments already cover this booking. Reject this payment instead of verifying it', 409, 'WALLET_PAYMENT_EXCEEDS_DUE');
  }
  const { count } = await tx.payment.updateMany({
    where: { id: wallet.id, status: 'pending' }, data: { status: 'succeeded', recordedById: actorId, receivedAt: new Date() },
  });
  if (count === 0) throw bookingNotPending('This payment has already been handled');
  await tx.bookingEvent.create({
    data: {
      bookingId: booking.id, type: 'payment_received', userId: actorId,
      detail: `${receivedDetail(wallet.amount, wallet.method, wallet.reference)}, verified by staff`,
    },
  });
  return booking.payments.map((p) => (p.id === wallet.id ? { ...p, status: 'succeeded' as const } : p));
}
