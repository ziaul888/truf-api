import { z } from 'zod';
import { PaginationSchema } from '../common/schemas.js';
import { RequestIdSchema } from './platform-onboarding.schemas.js';
import { RecordReceiptSchema } from './platform-billing.schemas.js';
import { ApplicationPaymentReferenceSchema } from '../owner-applications/owner-applications.schemas.js';

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
  payment: RecordReceiptSchema.pick({
    method: true,
    receivedOn: true,
  })
    .extend({ reference: ApplicationPaymentReferenceSchema })
    .optional(),
});
export type ActivateApplication = z.infer<typeof ActivateApplicationSchema>;
