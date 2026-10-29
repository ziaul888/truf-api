import { z } from 'zod';
import { PhoneSchema } from '../customers/customers.schemas.js';

export const SendCodeSchema = z.object({ phone: PhoneSchema });
export type SendCodeInput = z.infer<typeof SendCodeSchema>;

export const VerifyCodeSchema = z.object({
  phone: PhoneSchema,
  code: z.string().trim().regex(/^\d{4,10}$/, 'Enter the code from the SMS'),
});
export type VerifyCodeInput = z.infer<typeof VerifyCodeSchema>;
