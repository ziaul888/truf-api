import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlatformCommands } from './platform-command.js';
import {
  PLATFORM_PAYMENT_KEY,
  paymentInstructions,
  SubscriptionPaymentMethod,
  type PaymentInstructions,
} from './platform-payment-instructions.js';
import type { PlatformActor } from './platform-session.js';

@Injectable()
export class PlatformPaymentInstructionsService {
  constructor(
    private readonly db: PrismaService,
    private readonly commands: PlatformCommands,
  ) {}

  get() {
    return paymentInstructions(this.db);
  }

  async save(
    actor: PlatformActor,
    requestId: string,
    data: PaymentInstructions,
  ) {
    const key = PLATFORM_PAYMENT_KEY;
    await this.commands.run(
      actor,
      { requestId, action: 'payment_methods_updated', payload: data },
      async (tx) => {
        await tx.systemState.upsert({
          where: { key },
          create: { key, data },
          update: { data },
        });
        return {
          targetId: key,
          details: {
            enabledMethods: SubscriptionPaymentMethod.options.filter(
              (method) => data[method],
            ),
          },
        };
      },
    );
    return this.get();
  }
}
