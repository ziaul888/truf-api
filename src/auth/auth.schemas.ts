import { z } from 'zod';

export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email'));

/** Rules for any newly chosen password. */
export const NewPasswordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200, 'Password must be at most 200 characters');

export const LoginSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1, 'Enter your password').max(200),
});

export type LoginInput = z.infer<typeof LoginSchema>;

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password').max(200),
    newPassword: NewPasswordSchema,
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ['newPassword'],
    message: 'New password must be different from the current one',
  });

export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
