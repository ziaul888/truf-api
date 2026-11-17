import { z } from 'zod';
import { PaginationSchema } from '../common/schemas.js';

export const ListMyTenantAccountsSchema = PaginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['draft', 'active', 'suspended', 'archived']).optional(),
});
export type ListMyTenantAccounts = z.infer<typeof ListMyTenantAccountsSchema>;
