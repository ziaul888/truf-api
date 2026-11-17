import { randomUUID } from 'node:crypto';
import type { PlatformSubscription } from '../generated/prisma/client.js';
import type { PlatformTx } from './platform-command.js';
import { billingPeriod } from './platform-billing-dates.js';
import { toDbDate } from '../slots/venue-time.js';
export function createPlatformInvoice(
  tx: PlatformTx,
  sub: PlatformSubscription,
  index: number,
  dueOn: string,
) {
  const period = billingPeriod(sub.anchorDate, sub.interval, index);
  return tx.platformInvoice.create({
    data: {
      number:
        'INV-' + randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase(),
      tenantId: sub.tenantId,
      subscriptionId: sub.id,
      periodIndex: index,
      periodStart: period.start,
      periodEnd: period.end,
      dueOn: toDbDate(dueOn),
      planName: sub.planName,
      interval: sub.interval,
      currency: sub.currency,
      amount: sub.amount,
    },
  });
}
