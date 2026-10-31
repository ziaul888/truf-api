import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { env } from '../config/env.js';
import { EmailService } from '../email/email.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DEFAULT_SLOT_SETTINGS, SlotSettingsService } from '../slots/slot-settings.service.js';
import type { NotificationsStored, UpdateNotificationsInput } from './notifications.schemas.js';
import { changedFields } from './settings-fields.js';
import { SettingsStore, type SectionMeta } from './settings-store.service.js';

export interface NotificationsDto extends SectionMeta {
  email: {
    configured: boolean;
    fromEmail: string;
    /** Null: the venue name (`effectiveFromName`). */
    fromName: string | null;
    /** Null: the venue's support email (`effectiveReplyTo`). */
    replyTo: string | null;
    effectiveFromName: string;
    effectiveReplyTo: string;
  };
  customer: { bookingConfirmed: true; bookingCancelled: true; refundIssued: boolean; slotBlocked: boolean };
  staff: { recipients: string[]; newBooking: boolean; customerCancelled: boolean; dueDigest: boolean };
}

export interface EmailLogDto {
  id: string;
  /** Masked: "ra***@example.com". */
  to: string;
  subject: string;
  kind: string;
  ok: boolean;
  error: string | null;
  createdAt: Date;
}

export const maskEmail = (address: string) => {
  const [local = '', domain = ''] = address.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
};

/**
 * Email preferences. `slotBlocked` and `newBooking` are the older `notifyCustomerOnBlock` and
 * `notifyAdminOnBooking` slot settings, read and written there, so both pages agree.
 */
@Injectable()
export class NotificationSettingsService {
  constructor(
    private readonly store: SettingsStore,
    private readonly slots: SlotSettingsService,
    private readonly email: EmailService,
    private readonly prisma: PrismaService,
  ) {}

  async get(): Promise<NotificationsDto> {
    const [prefs, slots, sender, meta] = await Promise.all([
      this.store.get('notifications'), this.slots.get(), this.email.sender(), this.store.meta('notifications'),
    ]);
    return {
      email: {
        configured: this.email.configured, fromEmail: env.EMAIL_FROM, fromName: prefs.fromName, replyTo: prefs.replyTo,
        effectiveFromName: sender.fromName, effectiveReplyTo: sender.replyTo,
      },
      customer: { bookingConfirmed: true, bookingCancelled: true, refundIssued: prefs.refundIssued, slotBlocked: slots.notifyCustomerOnBlock },
      staff: { recipients: prefs.staffRecipients, newBooking: slots.notifyAdminOnBooking, customerCancelled: prefs.customerCancelled, dueDigest: prefs.dueDigest },
      ...meta,
    };
  }

  async update(input: UpdateNotificationsInput, userId: string): Promise<NotificationsDto> {
    const before = await this.get();
    const current = await this.store.get('notifications');
    const next: NotificationsStored = {
      fromName: input.email?.fromName === undefined ? current.fromName : input.email.fromName,
      replyTo: input.email?.replyTo === undefined ? current.replyTo : input.email.replyTo,
      refundIssued: input.customer?.refundIssued ?? current.refundIssued,
      staffRecipients: input.staff?.recipients ?? current.staffRecipients,
      customerCancelled: input.staff?.customerCancelled ?? current.customerCancelled,
      dueDigest: input.staff?.dueDigest ?? current.dueDigest,
    };
    await this.store.put('notifications', next);
    const flags = { notifyCustomerOnBlock: input.customer?.slotBlocked, notifyAdminOnBooking: input.staff?.newBooking };
    if (flags.notifyCustomerOnBlock !== undefined || flags.notifyAdminOnBooking !== undefined) {
      await this.slots.update(Object.fromEntries(Object.entries(flags).filter(([, v]) => v !== undefined)));
    }
    const after = await this.get();
    const { updatedAt: _a, updatedBy: _b, ...was } = before;
    const { updatedAt: _c, updatedBy: _d, ...now } = after;
    await this.store.record('notifications', changedFields(was, now), userId);
    return this.get();
  }

  async reset(userId: string): Promise<NotificationsDto> {
    await this.store.reset('notifications', userId);
    const { notifyCustomerOnBlock, notifyAdminOnBooking } = DEFAULT_SLOT_SETTINGS;
    await this.slots.update({ notifyCustomerOnBlock, notifyAdminOnBooking });
    return this.get();
  }

  /** A short email with the current from name and reply-to. */
  async sendTest(to: string): Promise<{ sent: true }> {
    if (!this.email.configured) throw new AppError('Email is not set up yet (SENDGRID_API_KEY)', 400, 'EMAIL_NOT_CONFIGURED');
    const sender = await this.email.sender();
    const result = await this.email.deliver({
      to, kind: 'test', subject: `Test email from ${sender.fromName}`,
      text: [`This is a test email from ${sender.fromName}.`, `Replies go to ${sender.replyTo}.`].join('\n\n'),
    });
    if (!result.ok) throw new AppError(`The email provider refused it: ${result.error}`, 502, 'EMAIL_PROVIDER_ERROR');
    return { sent: true };
  }

  async log(page: number, limit: number) {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.emailLog.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
      this.prisma.emailLog.count(),
    ]);
    const data: EmailLogDto[] = rows.map((r) => ({ id: r.id, to: maskEmail(r.to), subject: r.subject, kind: r.kind, ok: r.ok, error: r.error, createdAt: r.createdAt }));
    return { data, total, page, limit };
  }
}
