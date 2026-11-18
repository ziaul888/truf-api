import { z } from 'zod';
import { EmailSchema, NewPasswordSchema } from '../auth/auth.schemas.js';
import { CreateTurfSchema } from '../platform/platform-onboarding.schemas.js';

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
});

export type SubmitOwnerApplication = z.infer<
  typeof SubmitOwnerApplicationSchema
>;
