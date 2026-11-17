import type { Prisma } from '../generated/prisma/client.js';
import type {
  InvoiceList,
  SubscriptionList,
} from './platform-billing.schemas.js';
import { billingToday } from './platform-billing-dates.js';
function paidStateFilter(
  status: SubscriptionList['status'],
  today: Date,
): Prisma.PlatformSubscriptionWhereInput {
  switch (status) {
    case 'scheduled':
      return {
        status: 'active',
        anchorDate: { gt: today },
        paidThrough: { gt: today },
      };
    case 'active':
      return {
        status: 'active',
        anchorDate: { lte: today },
        paidThrough: { gt: today },
      };
    case 'past_due':
      return {
        status: 'active',
        cancelAtPeriodEnd: false,
        paidThrough: { lte: today },
      };
    default:
      return {};
  }
}
function stateFilter(
  status: SubscriptionList['status'],
): Prisma.PlatformSubscriptionWhereInput {
  const today = billingToday();
  if (status === 'pending') return { status: 'pending' };
  if (status === 'cancelled')
    return {
      OR: [
        { status: 'cancelled' },
        {
          status: 'active',
          cancelAtPeriodEnd: true,
          paidThrough: { lte: today },
        },
      ],
    };
  return paidStateFilter(status, today);
}
export function subscriptionFilter(
  q: SubscriptionList,
): Prisma.PlatformSubscriptionWhereInput {
  return {
    AND: [
      ...(q.tenantId ? [{ tenantId: q.tenantId }] : []),
      ...(q.status ? [stateFilter(q.status)] : []),
      ...(q.search
        ? [
            {
              OR: [
                {
                  planName: {
                    contains: q.search,
                    mode: 'insensitive' as const,
                  },
                },
                {
                  tenant: {
                    name: { contains: q.search, mode: 'insensitive' as const },
                  },
                },
              ],
            },
          ]
        : []),
    ],
  };
}
export function invoiceFilter(
  q: InvoiceList,
): Prisma.PlatformInvoiceWhereInput {
  const status: Prisma.PlatformInvoiceWhereInput =
    q.status === 'overdue'
      ? { status: 'issued', dueOn: { lt: billingToday() } }
      : q.status
        ? { status: q.status }
        : {};
  return {
    ...status,
    ...(q.tenantId ? { tenantId: q.tenantId } : {}),
    ...(q.search
      ? {
          OR: [
            { number: { contains: q.search, mode: 'insensitive' } },
            { planName: { contains: q.search, mode: 'insensitive' } },
            { tenant: { name: { contains: q.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
}
