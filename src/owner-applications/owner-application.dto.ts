import type { Prisma } from '../generated/prisma/client.js';

export const ownerApplicationSelect = {
  id: true,
  turfName: true,
  slug: true,
  ownerName: true,
  ownerEmail: true,
  timezone: true,
  currency: true,
  planVersionId: true,
  billingInterval: true,
  planVersion: {
    select: {
      id: true,
      version: true,
      currency: true,
      monthlyAmount: true,
      yearlyAmount: true,
      plan: {
        select: { id: true, code: true, name: true, description: true },
      },
    },
  },
  status: true,
  reviewedAt: true,
  tenantId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OwnerApplicationSelect;

type ApplicationRow = Prisma.OwnerApplicationGetPayload<{
  select: typeof ownerApplicationSelect;
}>;

export const toOwnerApplicationDto = (row: ApplicationRow) => {
  const { planVersion, billingInterval, ...application } = row;
  return {
    ...application,
    billingInterval,
    plan:
      planVersion && billingInterval
        ? {
            id: planVersion.plan.id,
            versionId: planVersion.id,
            version: planVersion.version,
            code: planVersion.plan.code,
            name: planVersion.plan.name,
            description: planVersion.plan.description,
            interval: billingInterval,
            currency: planVersion.currency,
            monthlyAmount: planVersion.monthlyAmount,
            yearlyAmount: planVersion.yearlyAmount,
            selectedAmount:
              billingInterval === 'monthly'
                ? planVersion.monthlyAmount
                : planVersion.yearlyAmount,
          }
        : null,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
};
