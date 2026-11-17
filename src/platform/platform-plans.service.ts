import { Injectable } from '@nestjs/common';
import { PlatformCommands } from './platform-command.js';
import type { PlatformActor } from './platform-session.js';
import type { CreatePlan } from './platform-billing.schemas.js';
import { createPlan } from './platform-plan-writes.js';
import { PlatformBillingReadService } from './platform-billing-read.service.js';
@Injectable()
export class PlatformPlansService {
  constructor(
    private readonly commands: PlatformCommands,
    private readonly read: PlatformBillingReadService,
  ) {}
  async create(actor: PlatformActor, input: CreatePlan) {
    const id = await this.commands.run(
      actor,
      { requestId: input.requestId, action: 'plan_created', payload: input },
      (tx) => createPlan(tx, input),
    );
    return this.read.plan(id);
  }
}
