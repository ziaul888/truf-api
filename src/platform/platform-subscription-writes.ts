import { AppError } from '../common/app-error.js';
import { toDbDate } from '../slots/venue-time.js';
import type { PlatformTx } from './platform-command.js';
import { billingToday, subscriptionState } from './platform-billing-dates.js';
import { createPlatformInvoice } from './platform-invoice-builder.js';
import type {
  CreateSubscription,
  IssueRenewal,
  CancelSubscription,
} from './platform-billing.schemas.js';
async function availablePlan(tx: PlatformTx, id: string) {
  const row = await tx.platformPlanVersion.findFirst({
    where: { planId: id, plan: { isActive: true } },
    include: { plan: { select: { name: true } } },
    orderBy: { version: 'desc' },
  });
  if (!row)
    throw new AppError(
      'Choose an available subscription plan',
      400,
      'PLAN_NOT_AVAILABLE',
    );
  return row;
}
async function ensureNoCurrent(tx: PlatformTx, tenantId: string) {
  const current = await tx.platformSubscription.findFirst({
    where: { tenantId, status: { not: 'cancelled' } },
  });
  if (!current) return;
  if (subscriptionState(current) === 'cancelled') {
    await tx.platformSubscription.update({
      where: { id: current.id },
      data: { status: 'cancelled' },
    });
    return;
  }
  throw new AppError(
    'This turf already has a current subscription',
    409,
    'CURRENT_SUBSCRIPTION_EXISTS',
  );
}
async function agreement(tx: PlatformTx, id: string) {
  const row = await tx.platformSubscription.findUnique({ where: { id } });
  if (!row)
    throw new AppError('Subscription not found', 404, 'SUBSCRIPTION_NOT_FOUND');
  return row;
}
async function requireOnboardedTurf(tx: PlatformTx, tenantId: string) {
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true },
  });
  if (!tenant)
    throw new AppError(
      'Turf business not found',
      404,
      'PLATFORM_TENANT_NOT_FOUND',
    );
  if (tenant.status === 'archived')
    throw new AppError(
      'An archived turf cannot start a subscription',
      409,
      'TENANT_ARCHIVED',
    );
}
async function storeAgreement(
  tx: PlatformTx,
  tenantId: string,
  input: CreateSubscription,
) {
  const version = await availablePlan(tx, input.planId);
  return tx.platformSubscription.create({
    data: {
      tenantId,
      planVersionId: version.id,
      planName: version.plan.name,
      interval: input.interval,
      currency: version.currency,
      amount:
        input.interval === 'monthly'
          ? version.monthlyAmount
          : version.yearlyAmount,
      anchorDate: toDbDate(input.startDate),
    },
  });
}
export async function createAgreement(
  tx: PlatformTx,
  tenantId: string,
  input: CreateSubscription,
) {
  await requireOnboardedTurf(tx, tenantId);
  await ensureNoCurrent(tx, tenantId);
  const sub = await storeAgreement(tx, tenantId, input);
  const invoice = await createPlatformInvoice(tx, sub, 0, input.dueOn);
  return {
    targetId: sub.id,
    tenantId,
    details: {
      invoiceId: invoice.id,
      planVersionId: sub.planVersionId,
      amount: sub.amount,
      interval: sub.interval,
    },
  };
}
async function renewalPeriod(tx: PlatformTx, id: string) {
  const open = await tx.platformInvoice.findFirst({
    where: { subscriptionId: id, status: 'issued' },
    select: { id: true },
  });
  if (open)
    throw new AppError(
      'Pay the open invoice before issuing another',
      409,
      'OPEN_INVOICE_EXISTS',
    );
  const paid = await tx.platformInvoice.findFirst({
    where: { subscriptionId: id, status: 'paid' },
    orderBy: { periodIndex: 'desc' },
    select: { periodIndex: true },
  });
  if (!paid)
    throw new AppError(
      'Pay the initial invoice before renewing',
      409,
      'SUBSCRIPTION_NOT_RENEWABLE',
    );
  return paid.periodIndex + 1;
}
export async function issueRenewal(
  tx: PlatformTx,
  id: string,
  input: IssueRenewal,
) {
  const sub = await agreement(tx, id);
  if (sub.status !== 'active' || sub.cancelAtPeriodEnd || !sub.paidThrough)
    throw new AppError(
      'This subscription cannot be renewed',
      409,
      'SUBSCRIPTION_NOT_RENEWABLE',
    );
  const index = await renewalPeriod(tx, id);
  const invoice = await createPlatformInvoice(tx, sub, index, input.dueOn);
  return {
    targetId: invoice.id,
    tenantId: sub.tenantId,
    details: {
      subscriptionId: id,
      periodIndex: invoice.periodIndex,
      amount: invoice.amount,
    },
  };
}
export async function cancelAgreement(
  tx: PlatformTx,
  id: string,
  input: CancelSubscription,
) {
  const sub = await agreement(tx, id);
  if (sub.status === 'cancelled' || sub.cancelAtPeriodEnd)
    throw new AppError(
      'Subscription renewal is already cancelled',
      409,
      'SUBSCRIPTION_ALREADY_CANCELLED',
    );
  const stillPaid = !!sub.paidThrough && sub.paidThrough > billingToday();
  await tx.platformSubscription.update({
    where: { id },
    data: {
      status: stillPaid ? 'active' : 'cancelled',
      cancelAtPeriodEnd: true,
      cancelledAt: new Date(),
      cancelReason: input.reason,
    },
  });
  await tx.platformInvoice.updateMany({
    where: { subscriptionId: id, status: 'issued' },
    data: { status: 'void' },
  });
  return {
    targetId: id,
    tenantId: sub.tenantId,
    details: { reason: input.reason, paidAccessPreserved: stillPaid },
  };
}
