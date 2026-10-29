import { z } from 'zod';
import { EmailSchema } from '../auth/auth.schemas.js';
import { PaginationSchema } from '../common/schemas.js';
import { oneOf } from '../grounds/grounds.schemas.js';
import { normalizePhone } from './phone.js';

/** Any common format; stored normalised ("+8801711000000"). */
export const PhoneSchema = z.string().trim().transform((value, ctx) => {
  const phone = normalizePhone(value);
  if (!phone) {
    ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number' });
    return z.NEVER;
  }
  return phone;
});

export const CustomerNameSchema = z.string().trim().min(1, 'Enter a name').max(100);

export const CUSTOMER_TAGS = ['vip', 'regular', 'new'] as const;
export const CUSTOMER_SORTS = ['lastBooking', 'totalSpent', 'bookings', 'since', 'due'] as const;

export const ListCustomersQuerySchema = PaginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  tag: oneOf(CUSTOMER_TAGS, 'Tag').optional(),
  hasDue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sort: oneOf(CUSTOMER_SORTS, 'Sort').default('lastBooking'),
});
export type ListCustomersQuery = z.infer<typeof ListCustomersQuerySchema>;

export const CustomerPhoneQuerySchema = z.object({ phone: PhoneSchema });
export type CustomerPhoneQuery = z.infer<typeof CustomerPhoneQuerySchema>;

const adminNote = z.string().trim().max(2000).nullable().optional();

export const CreateCustomerSchema = z.object({
  name: CustomerNameSchema,
  phone: PhoneSchema,
  email: EmailSchema,
  adminNote,
});
export type CreateCustomerInput = z.infer<typeof CreateCustomerSchema>;

export const UpdateCustomerSchema = CreateCustomerSchema.partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to update');
export type UpdateCustomerInput = z.infer<typeof UpdateCustomerSchema>;
