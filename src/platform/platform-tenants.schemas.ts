import { z } from 'zod';
import { PaginationSchema } from '../common/schemas.js';
export const PlatformTenantFiltersSchema = PaginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['draft', 'active', 'suspended', 'archived']).optional(),
});
export type PlatformTenantFilters = z.infer<typeof PlatformTenantFiltersSchema>;
