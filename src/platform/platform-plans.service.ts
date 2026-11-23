import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlatformCommands } from './platform-command.js';
import type { PlatformActor } from './platform-session.js';
import type { CreatePlan } from './platform-billing.schemas.js';
import { createPlan, removePlan } from './platform-plan-writes.js';
import { PlatformBillingReadService } from './platform-billing-read.service.js';
@Injectable()
export class PlatformPlansService {
  constructor(
    private readonly commands: PlatformCommands,
    private readonly read: PlatformBillingReadService,
    private readonly db: PrismaService,
  ) {}
  async create(actor: PlatformActor, input: CreatePlan) {
    const id = await this.commands.run(
      actor,
      { requestId: input.requestId, action: 'plan_created', payload: input },
      (tx) => createPlan(tx, input),
    );
    return this.read.plan(id);
  }

  async remove(actor: PlatformActor, id: string, requestId: string) {
    try {
      await this.commands.run(
        actor,
        { requestId, action: 'plan_removed', payload: { id } },
        (tx) => removePlan(tx, id),
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        throw new AppError(
          'The plan changed. Try removing it again.',
          409,
          'PLATFORM_CONFLICT',
        );
      }
      throw error;
    }
    const existing = await this.db.platformPlan.findUnique({
      where: { id },
      select: { id: true },
    });
    return {
      id,
      status: existing ? ('archived' as const) : ('deleted' as const),
    };
  }
}
