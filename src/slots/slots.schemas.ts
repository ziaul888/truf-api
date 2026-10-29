import { z } from 'zod';
import { PaginationSchema } from '../common/schemas.js';
import { hour, oneOf, WEEKDAYS } from '../grounds/grounds.schemas.js';

export const SLOT_STATUSES = ['available', 'held', 'booked', 'blocked'] as const;
export const BLOCK_REASONS = ['maintenance', 'reserved', 'event', 'weather', 'other'] as const;

/** A venue-local calendar date, "YYYY-MM-DD". */
export const isoDate = z.iso.date('Must be a date (YYYY-MM-DD)');

/** `?date=` alone, or `?from=&to=` together. Normalised to `{ from, to }`; the service checks order and length. */
const dateFields = { date: isoDate.optional(), from: isoDate.optional(), to: isoDate.optional() };
type DateFields = { date?: string; from?: string; to?: string };
const oneDateForm = (v: DateFields) =>
  v.date !== undefined ? v.from === undefined && v.to === undefined : (v.from === undefined) === (v.to === undefined);
const dateFormRule = { message: 'Send date, or both from and to', path: ['date'] };
const toRange = <T extends DateFields>({ date, from, to, ...rest }: T) => ({ ...rest, from: date ?? from, to: date ?? to });

export const PublicSlotsQuerySchema = z.object(dateFields)
  .refine((v) => oneDateForm(v) && (v.date !== undefined || v.from !== undefined), dateFormRule)
  .transform((v) => toRange(v) as { from: string; to: string });
export type PublicSlotsQuery = z.infer<typeof PublicSlotsQuerySchema>;

export const ListSlotsQuerySchema = PaginationSchema.extend({
  groundId: z.uuid('Invalid ground id').optional(),
  ...dateFields,
  status: oneOf(SLOT_STATUSES, 'Status').optional(),
  reason: oneOf(BLOCK_REASONS, 'Reason').optional(),
}).refine(oneDateForm, dateFormRule).transform(toRange);
export type ListSlotsQuery = z.infer<typeof ListSlotsQuerySchema>;

export const CalendarQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  groundId: z.uuid('Invalid ground id').optional(),
});
export type CalendarQuery = z.infer<typeof CalendarQuerySchema>;

export const GenerateSlotsSchema = z.object({
  groundId: z.union([z.uuid(), z.literal('all')], 'Pick a ground, or "all"'),
  fromDate: isoDate,
  toDate: isoDate,
  /** Existing slots are never overwritten; only `true` is accepted. */
  skipExisting: z.literal(true, 'Existing slots are never overwritten; skipExisting must be true').default(true),
  /** Count what would be generated without saving anything (the form's preview). */
  dryRun: z.boolean('dryRun must be true or false').default(false),
});
export type GenerateSlotsInput = z.infer<typeof GenerateSlotsSchema>;

export const blockFields = {
  reason: oneOf(BLOCK_REASONS, 'Reason'),
  note: z.string().trim().max(500, 'Note must be at most 500 characters').optional(),
};

export const BlockSlotSchema = z.object({
  ...blockFields,
  /** Blocking a booked slot: cancel the booking with a full refund. Without it, 409 SLOT_HAS_BOOKING. */
  cancelBooking: z.boolean('cancelBooking must be true or false').default(false),
});
export type BlockSlotInput = z.infer<typeof BlockSlotSchema>;

const startHour = hour(0, 23, 'Start hour');
const bulkBase = { groundId: z.uuid('Invalid ground id'), date: isoDate, ...blockFields };

export const BulkBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('single'), ...bulkBase, startHour }),
  z.object({ type: z.literal('fullDay'), ...bulkBase }),
  z.object({
    type: z.literal('recurringWeekly'),
    ...bulkBase,
    /** Omit to block whole days. */
    startHour: startHour.optional(),
    weekdays: z.array(oneOf(WEEKDAYS, 'Day')).min(1, 'Pick at least one day')
      .refine((list) => new Set(list).size === list.length, 'Days must not repeat'),
    untilDate: isoDate,
  }),
], { error: 'Type must be one of: single, fullDay, recurringWeekly' });
export type BulkBlockInput = z.infer<typeof BulkBlockSchema>;

const uniqueIds = (max: number) =>
  z.array(z.uuid('Invalid id')).min(1, 'Pick at least one slot').max(max, `At most ${max} slots at once`)
    .refine((ids) => new Set(ids).size === ids.length, 'Ids must not repeat');

export const BulkSlotsSchema = z.object({
  ids: uniqueIds(100),
  action: oneOf(['block', 'unblock'] as const, 'Action'),
  /** Required when blocking. */
  reason: oneOf(BLOCK_REASONS, 'Reason').optional(),
  note: blockFields.note,
}).refine((v) => v.action !== 'block' || v.reason !== undefined, { path: ['reason'], message: 'This field is required' });
export type BulkSlotsInput = z.infer<typeof BulkSlotsSchema>;

export const SLOT_EVENT_ACTIONS = ['block', 'unblock', 'close', 'reopen'] as const;

export const ListSlotEventsQuerySchema = PaginationSchema.extend({
  groundId: z.uuid('Invalid ground id').optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  action: oneOf(SLOT_EVENT_ACTIONS, 'Action').optional(),
  userId: z.uuid('Invalid user id').optional(),
}).refine((v) => (v.from === undefined) === (v.to === undefined), { path: ['from'], message: 'Send both from and to' });
export type ListSlotEventsQuery = z.infer<typeof ListSlotEventsQuerySchema>;

export const BulkUnblockSchema = z.object({
  groundId: z.uuid('Invalid ground id').optional(),
  date: isoDate,
});
export type BulkUnblockInput = z.infer<typeof BulkUnblockSchema>;

export const SlotSettingsSchema = z.object({
  advanceBookingDays: z.number().int('Must be a whole number').min(1).max(365),
  autoGenerate: z.boolean('autoGenerate must be true or false'),
  cancellationCutoffHours: z.number().int('Must be a whole number').min(0).max(72),
  notifyCustomerOnBlock: z.boolean('notifyCustomerOnBlock must be true or false'),
  notifyAdminOnBooking: z.boolean('notifyAdminOnBooking must be true or false'),
  /** Minutes a portal checkout holds its slot. */
  holdMinutes: z.number().int('Must be a whole number').min(5).max(30),
  /** Added to portal bookings, smallest currency unit. */
  serviceFee: z.number().int('Must be a whole number of the smallest unit').min(0).max(1_000_000),
  /** Portal customers may choose "pay cash at the venue". */
  portalCashEnabled: z.boolean('portalCashEnabled must be true or false'),
});
export type SlotSettings = z.infer<typeof SlotSettingsSchema>;

/** PUT may send any subset; the rest keeps its saved (or default) value. */
export const UpdateSlotSettingsSchema = SlotSettingsSchema.partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one setting to update');
export type UpdateSlotSettingsInput = z.infer<typeof UpdateSlotSettingsSchema>;
