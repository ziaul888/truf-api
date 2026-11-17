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
      currency: 'bdt',
    },
  };
}
