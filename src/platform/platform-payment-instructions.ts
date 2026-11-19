import { z } from 'zod';
import type { PlatformTx } from './platform-command.js';

export const PLATFORM_PAYMENT_KEY = 'platform_subscription_payment_methods';
export const SubscriptionPaymentMethod = z.enum([
  'bkash',
  'nagad',
  'bank_transfer',
]);
export type SubscriptionPaymentMethod = z.infer<
  typeof SubscriptionPaymentMethod
>;

export const PaymentInstructionsSchema = z.object({
  bkash: z.string().trim().max(200),
  nagad: z.string().trim().max(200),
  bank_transfer: z.string().trim().max(500),
});
export type PaymentInstructions = z.infer<typeof PaymentInstructionsSchema>;

const empty: PaymentInstructions = { bkash: '', nagad: '', bank_transfer: '' };

export async function paymentInstructions(db: PlatformTx) {
  const row = await db.systemState.findUnique({
    where: { key: PLATFORM_PAYMENT_KEY },
  });
  return PaymentInstructionsSchema.safeParse(row?.data).data ?? empty;
}
