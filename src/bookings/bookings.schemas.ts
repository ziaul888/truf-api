import { z } from 'zod';
import { OptionalEmailSchema } from '../auth/auth.schemas.js';
import { PaginationSchema } from '../common/schemas.js';
import { CustomerNameSchema, PhoneSchema } from '../customers/customers.schemas.js';
import { oneOf } from '../grounds/grounds.schemas.js';
import { isoDate } from '../slots/slots.schemas.js';
import { DUE_FILTERS } from './booking-due.js';
import { isWalletMethod } from './booking-rules.js';

export const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed', 'no_show'] as const;
export const BOOKING_PAYMENT_STATUSES = ['unpaid', 'partial', 'paid', 'refunded', 'failed'] as const;
/** Staff-recorded methods; card payments only come through Stripe. */
export const OFFLINE_METHODS = ['cash', 'bank_transfer', 'bkash', 'nagad'] as const;

const startHour = z.coerce.number('Must be a number').int('Must be a whole hour').min(0).max(23);
const note = (max: number) => z.string().trim().max(max).optional();

/** A bKash / Nagad transaction id: trimmed, uppercase, letters and digits, 6–20 characters. */
export const TrxIdSchema = z.string('Enter the transaction ID (TrxID)').trim().toUpperCase()
  .regex(/^[A-Z0-9]{6,20}$/, 'Enter the TrxID: 6 to 20 letters and digits');

/** The optional TrxID staff may record, only for bKash and Nagad. */
export const trxIdOnlyForWallets = (p: { method?: string; reference?: string }) =>
  p.reference === undefined || (p.method !== undefined && isWalletMethod(p.method));
export const TRX_ID_ONLY_FOR_WALLETS = { path: ['reference'], message: 'A TrxID is only recorded for bKash and Nagad' };

/** The portal form posts the hour as `hour`; `startHour` is accepted too. */
export const CheckoutSchema = z.preprocess(
  (v) => (v && typeof v === 'object' && !('startHour' in v) && 'hour' in v ? { ...v, startHour: (v as { hour: unknown }).hour } : v),
  z.object({
    groundId: z.uuid('Invalid ground id'),
    date: isoDate,
    startHour,
    customerName: CustomerNameSchema,
    /** Optional only for a signed-in customer (`400 EMAIL_REQUIRED` for a guest, checked in the service). */
    customerEmail: OptionalEmailSchema,
    customerPhone: PhoneSchema,
    /**
     * `cash` = pay at the venue: no Stripe, pending until staff confirm. `bkash` / `nagad`: the
     * customer has sent the total to the venue's number; pending until staff verify it.
     */
    paymentMethod: oneOf(['card', 'cash', 'bkash', 'nagad'] as const, 'Payment method').default('card'),
    /** bKash / Nagad only: the TrxID. */
    reference: TrxIdSchema.optional(),
    /** bKash / Nagad only: the number the money was sent from. */
    payerNumber: PhoneSchema.optional(),
  }).superRefine((v, ctx) => {
    if (!isWalletMethod(v.paymentMethod)) {
      // Refused rather than silently dropped.
      for (const field of ['reference', 'payerNumber'] as const) {
        if (v[field] !== undefined) ctx.addIssue({ code: 'custom', path: [field], message: 'Only for bKash and Nagad' });
      }
      return;
    }
    if (v.reference === undefined) ctx.addIssue({ code: 'custom', path: ['reference'], message: 'Enter the transaction ID (TrxID)' });
    if (v.payerNumber === undefined) ctx.addIssue({ code: 'custom', path: ['payerNumber'], message: 'Enter the number you sent the money from' });
  }),
);
export type CheckoutInput = z.infer<typeof CheckoutSchema>;

/** A signed-in customer's bookings: upcoming (soonest first) or past (latest first). */
export const MyBookingsQuerySchema = PaginationSchema.extend({
  scope: oneOf(['upcoming', 'past'] as const, 'Scope').default('upcoming'),
});
export type MyBookingsQuery = z.infer<typeof MyBookingsQuerySchema>;

export const BookingTokenQuerySchema = z.object({ token: z.string().max(100).optional() });
export type BookingTokenQuery = z.infer<typeof BookingTokenQuerySchema>;

export const ListBookingsQuerySchema = PaginationSchema.extend({
  status: oneOf(BOOKING_STATUSES, 'Status').optional(),
  paymentStatus: oneOf(BOOKING_PAYMENT_STATUSES, 'Payment status').optional(),
  groundId: z.uuid('Invalid ground id').optional(),
  customerId: z.uuid('Invalid customer id').optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Customer name or phone, or booking number. */
  search: z.string().trim().max(100).optional(),
  sort: oneOf(['slot', 'created'] as const, 'Sort').default('created'),
  /** Money due: `overdue` (past its due date, or the slot started), `today` (due date today), or `any`. */
  due: oneOf(DUE_FILTERS, 'Due').optional(),
}).refine((v) => (v.from === undefined) === (v.to === undefined), { path: ['from'], message: 'Send both from and to' });
export type ListBookingsQuery = z.infer<typeof ListBookingsQuerySchema>;

export const BOOKING_EVENT_TYPES = [
  'created', 'payment_received', 'confirmed', 'cancelled', 'refunded', 'email_sent', 'completed', 'cancel_requested', 'no_show',
] as const;

/** `type` may repeat (`?type=payment_received&type=refunded`). */
export const ListBookingEventsQuerySchema = PaginationSchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  type: z.preprocess((v) => (v === undefined ? undefined : [v].flat()), z.array(oneOf(BOOKING_EVENT_TYPES, 'Type')).optional()),
});
export type ListBookingEventsQuery = z.infer<typeof ListBookingEventsQuerySchema>;

export const UpcomingQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(20).default(5) });
export type UpcomingQuery = z.infer<typeof UpcomingQuerySchema>;

export const CreateStaffBookingSchema = z.object({
  slotId: z.uuid('Invalid slot id'),
  /** `id` books for an existing customer; otherwise the customer is found or created by phone. */
  /** `email` optional: left blank, the customer's stored one is used, else no customer emails. */
  customer: z.object({ id: z.uuid('Invalid customer id').optional(), name: CustomerNameSchema, phone: PhoneSchema, email: OptionalEmailSchema }),
  payment: z.object({
    type: oneOf(['full', 'partial', 'none'] as const, 'Payment type'),
    method: oneOf(OFFLINE_METHODS, 'Method').optional(),
    /** The advance, for `partial`. */
    amount: z.number().int('Must be a whole number of the smallest unit').min(1).optional(),
    dueDate: isoDate.optional(),
    note: note(500),
    /** bKash / Nagad: the TrxID, optional. */
    reference: TrxIdSchema.optional(),
  })
    .refine((p) => p.type === 'none' || p.method !== undefined, { path: ['method'], message: 'This field is required' })
    .refine(trxIdOnlyForWallets, TRX_ID_ONLY_FOR_WALLETS)
    .refine((p) => p.type !== 'none' || p.reference === undefined, { path: ['reference'], message: 'Nothing is paid now, so there is no TrxID' })
    .refine((p) => p.type !== 'partial' || p.amount !== undefined, { path: ['amount'], message: 'This field is required' }),
  notes: note(2000),
});
export type CreateStaffBookingInput = z.infer<typeof CreateStaffBookingSchema>;

export const ConfirmBookingSchema = z.object({
  /** Record the rest as received now. */
  markPaid: z.boolean().default(false),
  method: oneOf(OFFLINE_METHODS, 'Method').default('cash'),
  /** bKash / Nagad: the TrxID, optional. */
  reference: TrxIdSchema.optional(),
  notifyCustomer: z.boolean().default(true),
}).refine(trxIdOnlyForWallets, TRX_ID_ONLY_FOR_WALLETS);
export type ConfirmBookingInput = z.infer<typeof ConfirmBookingSchema>;

export const CancelBookingSchema = z.object({
  reason: note(500),
  refund: z.boolean('refund must be true or false'),
  notifyCustomer: z.boolean().default(true),
  /**
   * "Reject" on a bKash / Nagad payment: only cancel while that payment is still unverified, so a
   * Verify that landed first is never undone (409 PAYMENT_ALREADY_HANDLED).
   */
  rejectWalletPayment: z.boolean('rejectWalletPayment must be true or false').default(false),
});
export type CancelBookingInput = z.infer<typeof CancelBookingSchema>;

/** "Mark no-show": the reason is optional, as for a cancel. */
export const NoShowSchema = z.object({ reason: note(500) });
export type NoShowInput = z.infer<typeof NoShowSchema>;

export const RecordPaymentSchema = z.object({
  amount: z.number().int('Must be a whole number of the smallest unit').min(1, 'Amount must be above 0'),
  method: oneOf(OFFLINE_METHODS, 'Method'),
  /** bKash / Nagad: the TrxID, optional. */
  reference: TrxIdSchema.optional(),
  note: note(500),
}).refine(trxIdOnlyForWallets, TRX_ID_ONLY_FOR_WALLETS);
export type RecordPaymentInput = z.infer<typeof RecordPaymentSchema>;

export const UpdateBookingSchema = z.object({
  notes: z.string().trim().max(2000).nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  dueNote: z.string().trim().max(500).nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, 'Send at least one field to update');
export type UpdateBookingInput = z.infer<typeof UpdateBookingSchema>;
