import { z } from 'zod';
import { NewPasswordSchema } from '../auth/auth.schemas.js';
export const PreviewOwnerInvitationSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const AcceptOwnerInvitationSchema = PreviewOwnerInvitationSchema.extend({
  password: NewPasswordSchema,
});
export type AcceptOwnerInvitation = z.infer<typeof AcceptOwnerInvitationSchema>;
