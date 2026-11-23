import { AppError } from '../common/app-error.js';
import type { PlatformTx } from './platform-command.js';
import type { CreatePlan } from './platform-billing.schemas.js';
export async function createPlan(tx: PlatformTx, input: CreatePlan) {
  const exists = await tx.platformPlan.findUnique({
    where: { code: input.code },
    select: { id: true },
  });
  if (exists)
    throw new AppError(
      'This plan code is already in use',
      409,
      'PLAN_CODE_IN_USE',
    );
  const plan = await tx.platformPlan.create({
    data: {
      name: input.name,
      code: input.code,
      description: input.description || null,
      versions: {
        create: {
          version: 1,
          currency: 'bdt',
          monthlyAmount: input.monthlyAmount,
          yearlyAmount: input.yearlyAmount,
          trialDays: input.trialDays,
          features: input.features,
        },
      },
    },
  });
  return {
    targetId: plan.id,
    details: {
      version: 1,
      monthlyAmount: input.monthlyAmount,
      yearlyAmount: input.yearlyAmount,
      trialDays: input.trialDays ?? null,
      features: input.features,
      currency: 'bdt',
    },
  };
}

export async function removePlan(tx: PlatformTx, id: string) {
  const plan = await tx.platformPlan.findUnique({
    where: { id },
    select: { name: true, code: true },
  });
  if (!plan) throw new AppError('Plan not found', 404, 'PLAN_NOT_FOUND');

  const history = await tx.platformPlanVersion.findFirst({
    where: {
      planId: id,
      OR: [
        { subscriptions: { some: {} } },
        { ownerApplications: { some: {} } },
      ],
    },
    select: { id: true },
  });
  if (history) {
    await tx.platformPlan.update({ where: { id }, data: { isActive: false } });
  } else {
    await tx.platformPlanVersion.deleteMany({ where: { planId: id } });
    await tx.platformPlan.delete({ where: { id } });
  }
  return {
    targetId: id,
    details: { ...plan, status: history ? 'archived' : 'deleted' },
  };
}
