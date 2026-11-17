import { z } from 'zod';
import { EmailSchema } from '../auth/auth.schemas.js';
export const RequestIdSchema = z.object({ requestId: z.uuid() });
const reserved = new Set([
  'www',
  'app',
  'manage',
  'admin',
  'api',
  'auth',
  'billing',
  'support',
  'docs',
  'platform',
  'dashboard',
  'login',
  'signup',
  'account',
  'status',
]);
export const CreateTurfSchema = RequestIdSchema.extend({
  name: z.string().trim().min(2).max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(50)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .refine((v) => !reserved.has(v), 'This handle is reserved'),
  timezone: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .default('Asia/Dhaka')
    .refine((v) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, 'Enter a valid time zone'),
  currency: z.literal('bdt').default('bdt'),
  ownerName: z.string().trim().min(2).max(100),
  ownerEmail: EmailSchema,
});
export type CreateTurf = z.infer<typeof CreateTurfSchema>;
