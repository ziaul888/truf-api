import { z } from 'zod';
import { PaginationSchema } from '../common/schemas.js';
import { oneOf } from '../grounds/grounds.schemas.js';

export const REFUND_STATUSES = ['all', 'due', 'recorded'] as const;
const METHODS = ['card', 'cash', 'bank_transfer', 'bkash', 'nagad'] as const;

/** Refund history by booking. Only manual wallet refunds have a tracked "due" state. */
export const ListRefundBookingsQuerySchema = PaginationSchema.extend({
  status: oneOf(REFUND_STATUSES, 'Refund status').default('all'),
  method: oneOf(METHODS, 'Payment method').optional(),
  groundId: z.uuid('Invalid ground id').optional(),
  search: z.string().trim().max(100).optional(),
});
export type ListRefundBookingsQuery = z.infer<
  typeof ListRefundBookingsQuerySchema
>;
