import { AppError } from '../common/app-error.js';
import { toDbDate } from '../slots/venue-time.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { PlatformTx } from './platform-command.js';
import { billingToday } from './platform-billing-dates.js';
import type { RecordReceipt } from './platform-billing.schemas.js';
export const normalizedReceiptReference = (value: string) =>
  value.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
export async function payableInvoice(
  tx: PlatformTx,
  id: string,
  input: RecordReceipt,
) {
  const invoice = await tx.platformInvoice.findUnique({
    where: { id },
    include: { subscription: true },
  });
  if (!invoice)
    throw new AppError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  if (invoice.status !== 'issued')
    throw new AppError(
      'Only an unpaid invoice can receive payment',
      409,
      'INVOICE_NOT_PAYABLE',
    );
  validatePaymentPeriod(invoice, input);
  const duplicate = await tx.platformReceipt.findUnique({
    where: {
      method_referenceNormalized: {
        method: input.method,
        referenceNormalized: normalizedReceiptReference(input.reference),
      },
    },
    select: { id: true },
  });
  if (duplicate)
    throw new AppError(
      'This payment reference has already been recorded',
      409,
      'PAYMENT_REFERENCE_USED',
    );
  return invoice;
}
type Payable = Prisma.PlatformInvoiceGetPayload<{
  include: { subscription: true };
}>;
function validatePaymentPeriod(invoice: Payable, input: RecordReceipt) {
  const sub = invoice.subscription;
  if (sub.status === 'cancelled' || sub.cancelAtPeriodEnd)
    throw new AppError(
      'This subscription has been cancelled',
      409,
      'SUBSCRIPTION_CANCELLED',
    );
  if (toDbDate(input.receivedOn) > billingToday())
    throw new AppError(
      'Payment date cannot be in the future',
      400,
      'PAYMENT_DATE_IN_FUTURE',
    );
  const expected = sub.paidThrough ?? sub.anchorDate;
  if (invoice.periodStart.getTime() !== expected.getTime())
    throw new AppError(
      'Pay invoices in billing-period order',
      409,
      'BILLING_PERIOD_OUT_OF_ORDER',
    );
}
export async function storeReceipt(
  tx: PlatformTx,
  actorId: string,
  invoice: Payable,
  input: RecordReceipt,
) {
  const claimed = await tx.platformInvoice.updateMany({
    where: { id: invoice.id, status: 'issued' },
    data: { status: 'paid' },
  });
  if (claimed.count !== 1)
    throw new AppError(
      'This invoice has already been processed',
      409,
      'INVOICE_NOT_PAYABLE',
    );
  const receipt = await tx.platformReceipt.create({
    data: {
      invoiceId: invoice.id,
      tenantId: invoice.tenantId,
      amount: invoice.amount,
      currency: invoice.currency,
      method: input.method,
      reference: input.reference,
      referenceNormalized: normalizedReceiptReference(input.reference),
      receivedOn: toDbDate(input.receivedOn),
      recordedById: actorId,
    },
  });
  await tx.platformSubscription.update({
    where: { id: invoice.subscriptionId },
    data: { status: 'active', paidThrough: invoice.periodEnd },
  });
  return receipt;
}
