import { z } from 'zod';
import { EmailSchema, OptionalEmailSchema } from '../auth/auth.schemas.js';
import { CustomerNameSchema, PhoneSchema } from '../customers/customers.schemas.js';

export const SendCodeSchema = z.object({ phone: PhoneSchema });
export type SendCodeInput = z.infer<typeof SendCodeSchema>;

export const VerifyCodeSchema = z.object({
  phone: PhoneSchema,
  code: z.string().trim().regex(/^\d{4,10}$/, 'Enter the code from the SMS'),
  /** Optional sign-up details: with both, a new number gets its customer record straight away. */
  name: CustomerNameSchema.optional(),
  email: EmailSchema.optional(),
});
export type VerifyCodeInput = z.infer<typeof VerifyCodeSchema>;

/** Email optional: blank never clears a stored one (only staff can). */
export const CustomerProfileSchema = z.object({ name: CustomerNameSchema, email: OptionalEmailSchema });
export type CustomerProfileInput = z.infer<typeof CustomerProfileSchema>;
