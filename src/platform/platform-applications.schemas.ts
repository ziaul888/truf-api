import { z } from 'zod';
import { PaginationSchema } from '../common/schemas.js';
import { RequestIdSchema } from './platform-onboarding.schemas.js';

export const PlatformApplicationFiltersSchema = PaginationSchema.extend({
  status: z.enum(['pending', 'activated', 'rejected']).optional(),
});
export type PlatformApplicationFilters = z.infer<
  typeof PlatformApplicationFiltersSchema
>;

export const ReviewApplicationSchema = RequestIdSchema;
export type ReviewApplication = z.infer<typeof ReviewApplicationSchema>;
export const ActivateApplicationSchema = RequestIdSchema.extend({
  confirmed: z.literal(true),
});
export type ActivateApplication = z.infer<typeof ActivateApplicationSchema>;
