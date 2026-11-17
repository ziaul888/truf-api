import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { withPlatformAvailability } from './platform-availability.js';
import {
  platformPlanSelect,
  toPlanDto,
  subscriptionSelect,
  toSubscriptionDto,
  invoiceSelect,
  toInvoiceDto,
} from './platform-billing.dto.js';
import {
  invoiceFilter,
  subscriptionFilter,
} from './platform-billing-filters.js';
import type {
  BillingList,
  InvoiceList,
  SubscriptionList,
} from './platform-billing.schemas.js';
@Injectable()
export class PlatformBillingReadService {
  constructor(private readonly db: PrismaService) {}
  plans(q: BillingList) {
    return withPlatformAvailability(async () => {
      const where = q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' as const } },
              { code: { contains: q.search, mode: 'insensitive' as const } },
            ],
          }
        : {};
      const [rows, total] = await this.db.$transaction([
        this.db.platformPlan.findMany({
          where,
          select: platformPlanSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (q.page - 1) * q.limit,
          take: q.limit,
        }),
        this.db.platformPlan.count({ where }),
      ]);
      return { data: rows.map(toPlanDto), total, page: q.page, limit: q.limit };
    });
  }
  async plan(id: string) {
    const row = await this.db.platformPlan.findUniqueOrThrow({
      where: { id },
      select: platformPlanSelect,
    });
    return toPlanDto(row);
  }
  subscriptions(q: SubscriptionList) {
    return withPlatformAvailability(async () => {
      const where = subscriptionFilter(q);
      const [rows, total] = await this.db.$transaction([
        this.db.platformSubscription.findMany({
          where,
          select: subscriptionSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (q.page - 1) * q.limit,
          take: q.limit,
        }),
        this.db.platformSubscription.count({ where }),
      ]);
      return {
        data: rows.map(toSubscriptionDto),
        total,
        page: q.page,
        limit: q.limit,
      };
    });
  }
  subscription(id: string) {
    return withPlatformAvailability(async () => {
      const row = await this.db.platformSubscription.findUnique({
        where: { id },
        select: subscriptionSelect,
      });
      if (!row)
        throw new AppError(
          'Subscription not found',
          404,
          'SUBSCRIPTION_NOT_FOUND',
        );
      return toSubscriptionDto(row);
    });
  }
  invoices(q: InvoiceList) {
    return withPlatformAvailability(async () => {
      const where = invoiceFilter(q);
      const [rows, total] = await this.db.$transaction([
        this.db.platformInvoice.findMany({
          where,
          select: invoiceSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (q.page - 1) * q.limit,
          take: q.limit,
        }),
        this.db.platformInvoice.count({ where }),
      ]);
      return {
        data: rows.map(toInvoiceDto),
        total,
        page: q.page,
        limit: q.limit,
      };
    });
  }
  invoice(id: string) {
    return withPlatformAvailability(async () => {
      const row = await this.db.platformInvoice.findUnique({
        where: { id },
        select: invoiceSelect,
      });
      if (!row)
        throw new AppError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
      return toInvoiceDto(row);
    });
  }
  tenantBilling(tenantId: string) {
    return withPlatformAvailability(async () => {
      if (
        !(await this.db.tenant.findUnique({
          where: { id: tenantId },
          select: { id: true },
        }))
      )
        throw new AppError(
          'Turf business not found',
          404,
          'PLATFORM_TENANT_NOT_FOUND',
        );
      const [sub, invoices] = await this.db.$transaction([
        this.db.platformSubscription.findFirst({
          where: { tenantId },
          select: subscriptionSelect,
          orderBy: { createdAt: 'desc' },
        }),
        this.db.platformInvoice.findMany({
          where: { tenantId },
          select: invoiceSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 6,
        }),
      ]);
      return {
        subscription: sub ? toSubscriptionDto(sub) : null,
        recentInvoices: invoices.map(toInvoiceDto),
      };
    });
  }
  activity(tenantId: string, q: BillingList) {
    return withPlatformAvailability(async () => {
      const where = { tenantId };
      const [rows, total] = await this.db.$transaction([
        this.db.platformAuditEvent.findMany({
          where,
          select: {
            id: true,
            action: true,
            targetId: true,
            details: true,
            createdAt: true,
            actor: { select: { id: true, name: true } },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (q.page - 1) * q.limit,
          take: q.limit,
        }),
        this.db.platformAuditEvent.count({ where }),
      ]);
      return {
        data: rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
        })),
        total,
        page: q.page,
        limit: q.limit,
      };
    });
  }
}
