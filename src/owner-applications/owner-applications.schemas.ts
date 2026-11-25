import { z } from 'zod';
import { EmailSchema, NewPasswordSchema } from '../auth/auth.schemas.js';
import { CreateTurfSchema } from '../platform/platform-onboarding.schemas.js';
import { BillingDateSchema } from '../platform/platform-billing.schemas.js';
import { SubscriptionPaymentMethod } from '../platform/platform-payment-instructions.js';
import { normalizedReceiptReference } from '../platform/platform-receipt-writes.js';
import { detectImageType } from '../grounds/photo-storage.js';
import { LOGO_RULES } from '../settings/settings-images.js';

const LogoSchema = z
  .string()
  .max(
    'data:image/jpeg;base64,'.length + 4 * Math.ceil(LOGO_RULES.maxBytes / 3),
    'The logo must be 200 KB or smaller',
  )
  .refine((value) => {
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      value,
    );
    if (!match) return false;
    const [, mime, encoded] = match;
    const bytes = Buffer.from(encoded, 'base64');
    return (
      bytes.length <= LOGO_RULES.maxBytes &&
      bytes.toString('base64') === encoded &&
      detectImageType(bytes) === (mime === 'jpeg' ? 'jpg' : 'png')
    );
  }, 'Upload a valid PNG or JPG logo up to 200 KB');

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

export const SubmitOwnerApplicationSchema = z
  .union([
    ApplicationDetailsSchema.extend(ApplicationPaymentSchema.shape),
    ApplicationDetailsSchema.extend({
      paymentMethod: z.undefined().optional(),
      paymentReference: z.undefined().optional(),
      paymentDate: z.undefined().optional(),
    }),
  ])
  .and(z.object({ logo: LogoSchema.optional() }));

export type ApplicationPayment = z.infer<typeof ApplicationPaymentSchema>;

export type SubmitOwnerApplication = z.infer<
  typeof SubmitOwnerApplicationSchema
>;
