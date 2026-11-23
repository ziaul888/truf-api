import { z } from 'zod';
import { EmailSchema, NewPasswordSchema } from '../auth/auth.schemas.js';
import { CreateTurfSchema } from '../platform/platform-onboarding.schemas.js';
import { BillingDateSchema } from '../platform/platform-billing.schemas.js';
import { SubscriptionPaymentMethod } from '../platform/platform-payment-instructions.js';
import { normalizedReceiptReference } from '../platform/platform-receipt-writes.js';

const ApplicationDetailsSchema = CreateTurfSchema.pick({
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
  expectedAmount: z.number().int().min(0).max(1_000_000_000),
});

export const ApplicationPaymentReferenceSchema = z
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
  );

const ApplicationPaymentSchema = z.object({
  paymentMethod: SubscriptionPaymentMethod,
  paymentReference: ApplicationPaymentReferenceSchema,
  paymentDate: BillingDateSchema,
});

export const SubmitOwnerApplicationSchema = z.union([
  ApplicationDetailsSchema.extend(ApplicationPaymentSchema.shape),
  ApplicationDetailsSchema.extend({
    paymentMethod: z.undefined().optional(),
    paymentReference: z.undefined().optional(),
    paymentDate: z.undefined().optional(),
  }),
]);

export type ApplicationPayment = z.infer<typeof ApplicationPaymentSchema>;

export type SubmitOwnerApplication = z.infer<
  typeof SubmitOwnerApplicationSchema
>;
