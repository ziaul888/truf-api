import { z } from 'zod';
import { PaginationSchema } from '../common/schemas.js';
import { blockFields, isoDate } from './slots.schemas.js';

export const CreateClosureSchema = z.object({
  fromDate: isoDate,
  toDate: isoDate,
  /** Omit (or send []) to close every ground, including grounds added later. */
  groundIds: z.array(z.uuid('Invalid ground id')).max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Grounds must not repeat')
    .optional(),
  ...blockFields,
  /** Shown to customers, e.g. "Closed for Eid". */
  publicLabel: z.string().trim().min(1, 'Enter a label or leave it out').max(100).optional(),
});
export type CreateClosureInput = z.infer<typeof CreateClosureSchema>;

export const ListClosuresQuerySchema = PaginationSchema;
export type ListClosuresQuery = z.infer<typeof ListClosuresQuerySchema>;

export const PublicClosuresQuerySchema = z.object({ from: isoDate, to: isoDate });
export type PublicClosuresQuery = z.infer<typeof PublicClosuresQuerySchema>;
