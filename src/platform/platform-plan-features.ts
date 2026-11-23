import { SetMetadata } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AppError } from '../common/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';

export const PLAN_FEATURES = [
  'staff',
  'reports',
  'website',
  'refunds',
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

export const latestPlanFeatures = {
  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  take: 1,
  select: { planVersion: { select: { features: true } } },
} satisfies Prisma.PlatformSubscriptionFindManyArgs;

export function planFeaturesOf(tenant: {
  platformSubscriptions: { planVersion: { features: string[] } }[];
}): readonly string[] {
  return tenant.platformSubscriptions[0]?.planVersion.features ?? PLAN_FEATURES;
}

const PLAN_FEATURE_KEY = 'plan-feature';
export const RequirePlanFeature = (feature: PlanFeature) =>
  SetMetadata(PLAN_FEATURE_KEY, feature);

export function assertRoutePlanFeature(
  reflector: Reflector,
  ctx: ExecutionContext,
  features: readonly string[],
) {
  const feature = reflector.getAllAndOverride<PlanFeature | undefined>(
    PLAN_FEATURE_KEY,
    [ctx.getHandler(), ctx.getClass()],
  );
  if (feature && !features.includes(feature)) {
    throw new AppError(
      'Your subscription plan does not include this feature',
      403,
      'PLAN_FEATURE_REQUIRED',
    );
  }
}
