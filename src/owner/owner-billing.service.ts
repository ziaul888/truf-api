import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { OwnerSession } from './owner-session.js';
import { requireOwner } from './owner-access.js';
import { ownerTransaction } from './owner-transaction.js';
import {
  billingDate,
  billingToday,
  subscriptionState,
} from '../platform/platform-billing-dates.js';
const subscriptionSelect = {
  id: true,
  tenantId: true,
  planName: true,
  interval: true,
  currency: true,
  amount: true,
  anchorDate: true,
  paidThrough: true,
  trialEndsOn: true,
  status: true,
  cancelAtPeriodEnd: true,
} as const;
const invoiceSelect = {
  id: true,
  number: true,
  planName: true,
  amount: true,
  currency: true,
  interval: true,
  periodStart: true,
  periodEnd: true,
  dueOn: true,
  status: true,
  createdAt: true,
} as const;
@Injectable()
export class OwnerBillingService {
  constructor(private readonly db: PrismaService) {}
  read(session: OwnerSession) {
    return ownerTransaction(this.db, async (tx) => {
      const context = await requireOwner(tx, session),
        tenantId = context.user.tenant.id;
      const sub = await tx.platformSubscription.findFirst({
        where: { tenantId },
        select: subscriptionSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const invoices = await tx.platformInvoice.findMany({
        where: { tenantId },
        select: invoiceSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 12,
      });
      return {
        subscription: sub ? subscriptionDto(sub) : null,
        invoices: invoices.map(invoiceDto),
      };
    });
  }
}

function subscriptionDto(
  sub: Prisma.PlatformSubscriptionGetPayload<{
    select: typeof subscriptionSelect;
  }>,
) {
  return {
    id: sub.id,
    planName: sub.planName,
    interval: sub.interval,
    amount: sub.amount,
    currency: sub.currency,
    startDate: billingDate(sub.anchorDate),
    paidThrough: sub.paidThrough ? billingDate(sub.paidThrough) : null,
    trialEndsOn: sub.trialEndsOn ? billingDate(sub.trialEndsOn) : null,
    status: subscriptionState(sub),
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
}
function invoiceDto(
  row: Prisma.PlatformInvoiceGetPayload<{ select: typeof invoiceSelect }>,
) {
  return {
    ...row,
    periodStart: billingDate(row.periodStart),
    periodEnd: billingDate(row.periodEnd),
    dueOn: billingDate(row.dueOn),
    createdAt: row.createdAt.toISOString(),
    status:
      row.status === 'issued' && row.dueOn < billingToday()
        ? 'overdue'
        : row.status,
  };
}
