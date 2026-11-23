import { z } from 'zod';
import { PaginationSchema } from '../common/schemas.js';
import { PLAN_FEATURES } from './platform-plan-features.js';
import { RequestIdSchema } from './platform-onboarding.schemas.js';
export const BillingDateSchema = z.iso
  .date()
  .refine(
    (v) => v >= '2000-01-01' && v <= '2100-12-31',
    'Enter a date between 2000 and 2100',
  );
const amount = z.number().int().min(1).max(1_000_000_000);
const PlanDetailsSchema = RequestIdSchema.extend({
  name: z.string().trim().min(2).max(80),
  code: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().max(500).optional(),
  features: z
    .array(z.enum(PLAN_FEATURES))
    .max(PLAN_FEATURES.length)
    .transform((features) => [...new Set(features)])
    .default([...PLAN_FEATURES]),
});
export const CreatePlanSchema = z.union([
  PlanDetailsSchema.extend({
    trialDays: z.undefined().optional(),
    monthlyAmount: amount,
    yearlyAmount: amount,
  }),
  PlanDetailsSchema.extend({
    trialDays: z.number().int().min(1).max(365),
    monthlyAmount: z.literal(0).default(0),
    yearlyAmount: z.literal(0).default(0),
  }),
]);
export const CreateSubscriptionSchema = RequestIdSchema.extend({
  planId: z.uuid(),
  interval: z.enum(['monthly', 'yearly']),
  startDate: BillingDateSchema,
  dueOn: BillingDateSchema,
});
export const IssueRenewalSchema = RequestIdSchema.extend({
  dueOn: BillingDateSchema,
});
export const CancelSubscriptionSchema = RequestIdSchema.extend({
  reason: z.string().trim().min(5).max(500),
});
export const RecordReceiptSchema = RequestIdSchema.extend({
  method: z.enum(['bkash', 'nagad', 'bank_transfer']),
  reference: z.string().trim().min(3).max(100),
  receivedOn: BillingDateSchema,
  confirmed: z.literal(true),
});
export const BillingListSchema = PaginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  tenantId: z.uuid().optional(),
});
export const InvoiceListSchema = BillingListSchema.extend({
  status: z.enum(['issued', 'overdue', 'paid', 'void']).optional(),
});
export const SubscriptionListSchema = BillingListSchema.extend({
  status: z
    .enum([
      'pending',
      'scheduled',
      'active',
      'trialing',
      'trial_ended',
      'past_due',
      'cancelled',
    ])
    .optional(),
});
export type CreatePlan = z.infer<typeof CreatePlanSchema>;
export type CreateSubscription = z.infer<typeof CreateSubscriptionSchema>;
export type IssueRenewal = z.infer<typeof IssueRenewalSchema>;
export type CancelSubscription = z.infer<typeof CancelSubscriptionSchema>;
export type RecordReceipt = z.infer<typeof RecordReceiptSchema>;
export type BillingList = z.infer<typeof BillingListSchema>;
export type InvoiceList = z.infer<typeof InvoiceListSchema>;
export type SubscriptionList = z.infer<typeof SubscriptionListSchema>;
