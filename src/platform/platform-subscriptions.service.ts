import { Injectable } from '@nestjs/common';
import { PlatformCommands } from './platform-command.js';
import type { PlatformActor } from './platform-session.js';
import type {
  CreateSubscription,
  IssueRenewal,
  CancelSubscription,
} from './platform-billing.schemas.js';
import {
  createAgreement,
  issueRenewal,
  cancelAgreement,
} from './platform-subscription-writes.js';
import { PlatformBillingReadService } from './platform-billing-read.service.js';
@Injectable()
export class PlatformSubscriptionsService {
  constructor(
    private readonly commands: PlatformCommands,
    private readonly read: PlatformBillingReadService,
  ) {}
  async create(
    actor: PlatformActor,
    tenantId: string,
    input: CreateSubscription,
  ) {
    const id = await this.commands.run(
      actor,
      {
        requestId: input.requestId,
        action: 'subscription_created',
        payload: { tenantId, ...input },
      },
      (tx) => createAgreement(tx, tenantId, input),
    );
    return this.read.subscription(id);
  }
  async renew(
    actor: PlatformActor,
    subscriptionId: string,
    input: IssueRenewal,
  ) {
    const id = await this.commands.run(
      actor,
      {
        requestId: input.requestId,
        action: 'invoice_issued',
        payload: { subscriptionId, ...input },
      },
      (tx) => issueRenewal(tx, subscriptionId, input),
    );
    return this.read.invoice(id);
  }
  async cancel(
    actor: PlatformActor,
    subscriptionId: string,
    input: CancelSubscription,
  ) {
    const id = await this.commands.run(
      actor,
      {
        requestId: input.requestId,
        action: 'subscription_cancelled',
        payload: { subscriptionId, ...input },
      },
      (tx) => cancelAgreement(tx, subscriptionId, input),
    );
    return this.read.subscription(id);
  }
}
