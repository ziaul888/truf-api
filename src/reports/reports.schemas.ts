import { z } from 'zod';
import { oneOf } from '../grounds/grounds.schemas.js';
import { isoDate } from '../slots/slots.schemas.js';

export const GROUP_BYS = ['day', 'week', 'month'] as const;
export type GroupBy = (typeof GROUP_BYS)[number];
export const EXPORT_TYPES = ['revenue', 'bookings', 'customers'] as const;

type Range = { from?: string; to?: string };
const ordered = (v: Range) => !v.from || !v.to || v.from <= v.to;
const orderRule = { message: 'from must not be after to', path: ['from'] };
const groupBy = oneOf(GROUP_BYS, 'Group by').optional();

/** `?from=&to=`: venue-local dates, both inclusive. The service caps the length (RANGE_TOO_LONG). */
export const ReportRangeSchema = z.object({ from: isoDate, to: isoDate }).refine(ordered, orderRule);
export type ReportRange = z.infer<typeof ReportRangeSchema>;

/** `groupBy` left out: day up to 31 days, week up to 92, month beyond. */
export const ReportSeriesQuerySchema = z.object({ from: isoDate, to: isoDate, groupBy }).refine(ordered, orderRule);
export type ReportSeriesQuery = z.infer<typeof ReportSeriesQuerySchema>;

export const ExportQuerySchema = z.object({
  type: oneOf(EXPORT_TYPES, 'Export type'),
  from: isoDate.optional(),
  to: isoDate.optional(),
  groupBy,
})
  .refine((v) => (v.from === undefined) === (v.to === undefined), { message: 'Send both from and to', path: ['to'] })
  .refine(ordered, orderRule)
  .refine((v) => v.type === 'customers' || v.from !== undefined, { message: 'Send from and to', path: ['from'] })
  .refine((v) => v.type !== 'revenue' || v.groupBy === 'day' || v.groupBy === 'week', {
    message: 'The revenue export groups by day or week', path: ['groupBy'],
  });
export type ExportQuery = z.infer<typeof ExportQuerySchema>;
