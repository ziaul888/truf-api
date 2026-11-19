import { z } from 'zod';
import { EmailSchema, NewPasswordSchema } from '../auth/auth.schemas.js';
import { CreateTurfSchema } from '../platform/platform-onboarding.schemas.js';
import { BillingDateSchema } from '../platform/platform-billing.schemas.js';
import { SubscriptionPaymentMethod } from '../platform/platform-payment-instructions.js';
import { normalizedReceiptReference } from '../platform/platform-receipt-writes.js';

export const SubmitOwnerApplicationSchema = CreateTurfSchema.pick({
  requestId: true,
  name: true,
  slug: true,
  timezone: true,
  currency: true,
  ownerName: true,
}).extend({
  ownerEmail: EmailSchema,
  password: NewPasswordSchema,
  planId: z.uuid('Choose a subscription plan'),
  interval: z.enum(['monthly', 'yearly']),
  planVersion: z.number().int().positive(),
  expectedAmount: z.number().int().positive().max(1_000_000_000),
  paymentMethod: SubscriptionPaymentMethod,
  paymentReference: z
    .string()
    .max(100)
    .transform(normalizedReceiptReference)
    .pipe(
      z
        .string()
        .regex(
          /^[A-Z0-9][A-Z0-9._/-]{2,99}$/,
          'Enter a valid transaction reference',
        ),
    ),
  paymentDate: BillingDateSchema,
});

export type SubmitOwnerApplication = z.infer<
  typeof SubmitOwnerApplicationSchema
>;
