import { z } from 'zod';
import { EmailSchema } from '../auth/auth.schemas.js';
import { PaginationSchema } from '../common/schemas.js';
import { CustomerNameSchema, PhoneSchema } from '../customers/customers.schemas.js';
import { oneOf } from '../grounds/grounds.schemas.js';
import { isoDate } from '../slots/slots.schemas.js';
import { DUE_FILTERS } from './booking-due.js';

export const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed'] as const;
export const BOOKING_PAYMENT_STATUSES = ['unpaid', 'partial', 'paid', 'refunded', 'failed'] as const;
/** Staff-recorded methods; card payments only come through Stripe. */
export const OFFLINE_METHODS = ['cash', 'bank_transfer'] as const;

const startHour = z.coerce.number('Must be a number').int('Must be a whole hour').min(0).max(23);
const note = (max: number) => z.string().trim().max(max).optional();

/** The portal form posts the hour as `hour`; `startHour` is accepted too. */
export const CheckoutSchema = z.preprocess(
  (v) => (v && typeof v === 'object' && !('startHour' in v) && 'hour' in v ? { ...v, startHour: (v as { hour: unknown }).hour } : v),
  z.object({
    groundId: z.uuid('Invalid ground id'),
    date: isoDate,
    startHour,
    customerName: CustomerNameSchema,
    customerEmail: EmailSchema,
    customerPhone: PhoneSchema,
    /** `cash` = pay at the venue: no Stripe, pending until staff confirm. */
    paymentMethod: oneOf(['card', 'cash'] as const, 'Payment method').default('card'),
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

export const BOOKING_EVENT_TYPES = ['created', 'payment_received', 'confirmed', 'cancelled', 'refunded', 'email_sent', 'completed'] as const;

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
  customer: z.object({ id: z.uuid('Invalid customer id').optional(), name: CustomerNameSchema, phone: PhoneSchema, email: EmailSchema }),
  payment: z.object({
    type: oneOf(['full', 'partial', 'none'] as const, 'Payment type'),
    method: oneOf(OFFLINE_METHODS, 'Method').optional(),
    /** The advance, for `partial`. */
    amount: z.number().int('Must be a whole number of the smallest unit').min(1).optional(),
    dueDate: isoDate.optional(),
    note: note(500),
  })
    .refine((p) => p.type === 'none' || p.method !== undefined, { path: ['method'], message: 'This field is required' })
    .refine((p) => p.type !== 'partial' || p.amount !== undefined, { path: ['amount'], message: 'This field is required' }),
  notes: note(2000),
});
export type CreateStaffBookingInput = z.infer<typeof CreateStaffBookingSchema>;

export const ConfirmBookingSchema = z.object({
  /** Record the rest as received now. */
  markPaid: z.boolean().default(false),
  method: oneOf(OFFLINE_METHODS, 'Method').default('cash'),
  notifyCustomer: z.boolean().default(true),
});
export type ConfirmBookingInput = z.infer<typeof ConfirmBookingSchema>;

export const CancelBookingSchema = z.object({
  reason: note(500),
  refund: z.boolean('refund must be true or false'),
  notifyCustomer: z.boolean().default(true),
});
export type CancelBookingInput = z.infer<typeof CancelBookingSchema>;

export const RecordPaymentSchema = z.object({
  amount: z.number().int('Must be a whole number of the smallest unit').min(1, 'Amount must be above 0'),
  method: oneOf(OFFLINE_METHODS, 'Method'),
  note: note(500),
});
export type RecordPaymentInput = z.infer<typeof RecordPaymentSchema>;

export const UpdateBookingSchema = z.object({
  notes: z.string().trim().max(2000).nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  dueNote: z.string().trim().max(500).nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, 'Send at least one field to update');
export type UpdateBookingInput = z.infer<typeof UpdateBookingSchema>;
