import { Injectable } from '@nestjs/common';
import { PlatformCommands } from './platform-command.js';
import type { PlatformActor } from './platform-session.js';
import type { RecordReceipt } from './platform-billing.schemas.js';
import { payableInvoice, storeReceipt } from './platform-receipt-writes.js';
import { PlatformBillingReadService } from './platform-billing-read.service.js';
@Injectable()
export class PlatformReceiptsService {
  constructor(
    private readonly commands: PlatformCommands,
    private readonly read: PlatformBillingReadService,
  ) {}
  async record(actor: PlatformActor, invoiceId: string, input: RecordReceipt) {
    const id = await this.commands.run(
      actor,
      {
        requestId: input.requestId,
        action: 'invoice_paid',
        payload: { invoiceId, ...input },
      },
      async (tx) => {
        const invoice = await payableInvoice(tx, invoiceId, input);
        const receipt = await storeReceipt(tx, actor.userId, invoice, input);
        return {
          targetId: invoice.id,
          tenantId: invoice.tenantId,
          details: {
            receiptId: receipt.id,
            amount: receipt.amount,
            currency: receipt.currency,
            method: receipt.method,
          },
        };
      },
    );
    return this.read.invoice(id);
  }
}
