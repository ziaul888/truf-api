import { AppError } from '../common/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  billingDate,
  billingToday,
  subscriptionState,
} from './platform-billing-dates.js';
export const platformPlanSelect = {
  id: true,
  code: true,
  name: true,
  description: true,
  isActive: true,
  createdAt: true,
  versions: { orderBy: { version: 'desc' }, take: 1 },
} satisfies Prisma.PlatformPlanSelect;
export function toPlanDto(
  row: Prisma.PlatformPlanGetPayload<{ select: typeof platformPlanSelect }>,
) {
  const version = row.versions[0];
  if (!version)
    throw new AppError(
      'Plan prices are not configured',
      409,
      'PLAN_NOT_AVAILABLE',
    );
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    version: version.version,
    currency: version.currency,
    monthlyAmount: version.monthlyAmount,
    yearlyAmount: version.yearlyAmount,
  };
}
export const subscriptionSelect = {
  id: true,
  tenantId: true,
  planName: true,
  planVersionId: true,
  interval: true,
  currency: true,
  amount: true,
  anchorDate: true,
  paidThrough: true,
  status: true,
  cancelAtPeriodEnd: true,
  cancelledAt: true,
  cancelReason: true,
  createdAt: true,
  tenant: { select: { id: true, name: true, slug: true } },
  _count: { select: { invoices: { where: { status: 'issued' } } } },
} satisfies Prisma.PlatformSubscriptionSelect;
export function toSubscriptionDto(
  row: Prisma.PlatformSubscriptionGetPayload<{
    select: typeof subscriptionSelect;
  }>,
) {
  const status = subscriptionState(row);
  return {
    id: row.id,
    tenantId: row.tenantId,
    tenant: row.tenant,
    planName: row.planName,
    planVersionId: row.planVersionId,
    interval: row.interval,
    currency: row.currency,
    amount: row.amount,
    startDate: billingDate(row.anchorDate),
    paidThrough: row.paidThrough ? billingDate(row.paidThrough) : null,
    status,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    cancellationRequestedAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
    createdAt: row.createdAt.toISOString(),
    canRenew:
      row.status === 'active' &&
      !row.cancelAtPeriodEnd &&
      row._count.invoices === 0,
    openInvoiceCount: row._count.invoices,
  };
}
export const invoiceSelect = {
  id: true,
  number: true,
  tenantId: true,
  subscriptionId: true,
  periodIndex: true,
  periodStart: true,
  periodEnd: true,
  dueOn: true,
  planName: true,
  interval: true,
  currency: true,
  amount: true,
  status: true,
  createdAt: true,
  tenant: { select: { id: true, name: true, slug: true } },
  receipt: {
    select: {
      id: true,
      method: true,
      reference: true,
      amount: true,
      currency: true,
      receivedOn: true,
      createdAt: true,
      recordedBy: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.PlatformInvoiceSelect;
export function toInvoiceDto(
  row: Prisma.PlatformInvoiceGetPayload<{ select: typeof invoiceSelect }>,
) {
  return {
    id: row.id,
    number: row.number,
    tenantId: row.tenantId,
    tenant: row.tenant,
    subscriptionId: row.subscriptionId,
    periodIndex: row.periodIndex,
    periodStart: billingDate(row.periodStart),
    periodEnd: billingDate(row.periodEnd),
    dueOn: billingDate(row.dueOn),
    planName: row.planName,
    interval: row.interval,
    currency: row.currency,
    amount: row.amount,
    status:
      row.status === 'issued' && row.dueOn < billingToday()
        ? 'overdue'
        : row.status,
    createdAt: row.createdAt.toISOString(),
    receipt: row.receipt
      ? {
          ...row.receipt,
          receivedOn: billingDate(row.receipt.receivedOn),
          createdAt: row.receipt.createdAt.toISOString(),
        }
      : null,
  };
}
