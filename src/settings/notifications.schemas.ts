import { z } from 'zod';

const email = z.email('Enter a valid email');

/** What's stored. The two flags that predate this section stay in SlotSettings (see NotificationSettingsService). */
export const NotificationsStoredSchema = z.object({
  /** Null: the venue name. */
  fromName: z.string().trim().min(1).max(60).nullable(),
  /** Null: the venue's support email (or its email). */
  replyTo: email.nullable(),
  refundIssued: z.boolean(),
  /** Empty: every active admin. */
  staffRecipients: z.array(email).max(5),
  customerCancelled: z.boolean(),
  dueDigest: z.boolean(),
});
export type NotificationsStored = z.infer<typeof NotificationsStoredSchema>;

export const DEFAULT_NOTIFICATIONS: NotificationsStored = {
  fromName: null, replyTo: null, refundIssued: true, staffRecipients: [], customerCancelled: true, dueDigest: true,
};

/** Confirmation and cancellation emails carry the booking link, so they can't be switched off. */
const alwaysOn = z.literal(true, 'Confirmation and cancellation emails always send').optional();

export const UpdateNotificationsSchema = z.object({
  email: z.object({ fromName: z.string().trim().min(1).max(60).nullable().optional(), replyTo: email.nullable().optional() }).optional(),
  customer: z.object({
    bookingConfirmed: alwaysOn,
    bookingCancelled: alwaysOn,
    refundIssued: z.boolean().optional(),
    slotBlocked: z.boolean().optional(),
  }).optional(),
  staff: z.object({
    recipients: z.array(email).max(5, 'Up to 5 recipients').optional(),
    newBooking: z.boolean().optional(),
    customerCancelled: z.boolean().optional(),
    dueDigest: z.boolean().optional(),
  }).optional(),
}).refine((v) => Object.keys(v).length > 0, 'Send at least one part to update');
export type UpdateNotificationsInput = z.infer<typeof UpdateNotificationsSchema>;

export const TestEmailSchema = z.object({ to: email.optional() });
export type TestEmailInput = z.infer<typeof TestEmailSchema>;

export const SETTINGS_SECTIONS = ['slots', 'notifications', 'website'] as const;
export const ResetSettingsSchema = z.object({ sections: z.array(z.enum(SETTINGS_SECTIONS, 'Unknown section')).min(1).optional() });
export type ResetSettingsInput = z.infer<typeof ResetSettingsSchema>;
