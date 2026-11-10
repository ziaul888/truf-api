import { z } from 'zod';
import { CreateStaffBookingSchema, OFFLINE_METHODS, TRX_ID_ONLY_FOR_WALLETS, TrxIdSchema, trxIdOnlyForWallets } from '../bookings/bookings.schemas.js';
import { hour, oneOf, WEEKDAYS } from '../grounds/grounds.schemas.js';
import { isoDate } from '../slots/slots.schemas.js';
import { daysBetween, venueNow } from '../slots/venue-time.js';

/** A fixed series covers at most this many days, both ends included. */
export const MAX_FIXED_SERIES_DAYS = 31;

const isTodayOrLater = (date: string) => date >= venueNow().date;
const TODAY_OR_LATER = 'Must be today or later';
const amount = z.number().int('Must be a whole number of the smallest unit').min(1, 'Amount must be above 0');

const seriesFields = {
  groundId: z.uuid('Invalid ground id'),
  startHour: hour(0, 23, 'Start hour'),
  weekdays: z.array(oneOf(WEEKDAYS, 'Day')).min(1, 'Pick at least one day')
    .refine((list) => new Set(list).size === list.length, 'Days must not repeat'),
  fromDate: isoDate.refine(isTodayOrLater, TODAY_OR_LATER),
  /** Null (or left out) = ongoing: keeps booking as slots are generated, until stopped. */
  untilDate: isoDate.nullable().default(null),
};

/** A fixed range runs from fromDate to untilDate, at most MAX_FIXED_SERIES_DAYS days. */
const checkRange = (v: { fromDate: string; untilDate: string | null }, ctx: z.RefinementCtx) => {
  if (v.untilDate === null) return;
  if (v.untilDate < v.fromDate) ctx.addIssue({ code: 'custom', path: ['untilDate'], message: 'Must not be before the start date' });
  else if (daysBetween(v.fromDate, v.untilDate) + 1 > MAX_FIXED_SERIES_DAYS) {
    ctx.addIssue({ code: 'custom', path: ['untilDate'], message: `Pick a range of at most ${MAX_FIXED_SERIES_DAYS} days` });
  }
};

export const PreviewSeriesSchema = z.object(seriesFields).superRefine(checkRange);
export type PreviewSeriesInput = z.infer<typeof PreviewSeriesSchema>;

const SeriesPaymentSchema = z.object({
  type: oneOf(['full', 'partial', 'none'] as const, 'Payment type'),
  method: oneOf(OFFLINE_METHODS, 'Method').optional(),
  /** The advance, for `partial`: less than the total of the bookings made. */
  amount: amount.optional(),
  /** bKash / Nagad: the TrxID, optional. */
  reference: TrxIdSchema.optional(),
})
  .refine((p) => p.type === 'none' || p.method !== undefined, { path: ['method'], message: 'This field is required' })
  .refine(trxIdOnlyForWallets, TRX_ID_ONLY_FOR_WALLETS)
  .refine((p) => p.type !== 'none' || p.reference === undefined, { path: ['reference'], message: 'Nothing is paid now, so there is no TrxID' })
  .refine((p) => p.type !== 'partial' || p.amount !== undefined, { path: ['amount'], message: 'This field is required' });

export const CreateSeriesSchema = z.object({
  ...seriesFields,
  /** As for a staff booking: `id` books for an existing customer; otherwise found or created by phone. */
  customer: CreateStaffBookingSchema.shape.customer,
  notes: z.string().trim().max(2000).optional(),
  payment: SeriesPaymentSchema,
}).superRefine(checkRange);
export type CreateSeriesInput = z.infer<typeof CreateSeriesSchema>;

export const SeriesPaymentRecordSchema = z.object({
  amount,
  method: oneOf(OFFLINE_METHODS, 'Method'),
  /** bKash / Nagad: the TrxID, optional. */
  reference: TrxIdSchema.optional(),
  /** "YYYY-MM": only that month's bookings; left out, every month's (earliest first). */
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Must be a month (YYYY-MM)').optional(),
}).refine(trxIdOnlyForWallets, TRX_ID_ONLY_FOR_WALLETS);
export type SeriesPaymentRecordInput = z.infer<typeof SeriesPaymentRecordSchema>;

export const StopSeriesSchema = z.object({
  /** Bookings on this date and after (not yet started) are cancelled; earlier ones stay. */
  fromDate: isoDate.refine(isTodayOrLater, TODAY_OR_LATER),
  refund: z.boolean('refund must be true or false'),
  reason: z.string().trim().max(500).optional(),
});
export type StopSeriesInput = z.infer<typeof StopSeriesSchema>;
