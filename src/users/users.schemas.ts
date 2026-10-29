import { z } from 'zod';
import { EmailSchema, NewPasswordSchema } from '../auth/auth.schemas.js';
import { PaginationSchema } from '../common/schemas.js';

const NameSchema = z.string().trim().min(1, 'Enter a name').max(100);
const RoleSchema = z.enum(['admin', 'manager'], 'Role must be admin or manager');

export const ListUsersQuerySchema = PaginationSchema.extend({
  /** Matches name or email, case-insensitive. */
  search: z.string().trim().max(100).optional(),
});
export type ListUsersQuery = z.infer<typeof ListUsersQuerySchema>;

export const CreateUserSchema = z.object({
  email: EmailSchema,
  name: NameSchema,
  password: NewPasswordSchema,
  role: RoleSchema.default('manager'),
});
export type CreateUserInput = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z
  .object({
    email: EmailSchema,
    name: NameSchema,
    role: RoleSchema,
    isActive: z.boolean('isActive must be true or false'),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to update');
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

export const ResetPasswordSchema = z.object({ password: NewPasswordSchema });
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;
