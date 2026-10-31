import { Injectable, Logger } from '@nestjs/common';
import sendgrid from '@sendgrid/mail';
import { env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsStore } from '../settings/settings-store.service.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** For the email log, e.g. "booking_confirmed", "staff_new_booking", "test". */
  kind: string;
  bookingId?: string;
}

export interface Delivery {
  ok: boolean;
  /** Why it wasn't sent (SendGrid's reason, or "not configured"). */
  error?: string;
}

export interface Sender {
  fromEmail: string;
  fromName: string;
  replyTo: string;
}

const NOT_CONFIGURED = 'Email is not configured (SENDGRID_API_KEY)';

/**
 * Sends plain-text email through SendGrid, from EMAIL_FROM with the name and reply-to set on the
 * Notifications page. Every attempt is written to EmailLog. Without SENDGRID_API_KEY it logs and
 * skips. Tests mock it.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private keySet = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsStore,
  ) {}

  get configured(): boolean {
    return Boolean(env.SENDGRID_API_KEY);
  }

  /** True when the email was handed to SendGrid. Never throws: a failed email must not fail a booking. */
  async send(message: EmailMessage): Promise<boolean> {
    return (await this.deliver(message)).ok;
  }

  async deliver(message: EmailMessage): Promise<Delivery> {
    const result = await this.attempt(message);
    await this.prisma.emailLog
      .create({ data: { to: message.to, subject: message.subject, kind: message.kind, ok: result.ok, error: result.error ?? null, bookingId: message.bookingId ?? null } })
      .catch((err: unknown) => this.logger.error('Email log failed', err instanceof Error ? err.message : String(err)));
    return result;
  }

  /** The from name and reply-to: as set on the Notifications page, else from the venue profile. */
  async sender(): Promise<Sender> {
    const [prefs, venue] = await Promise.all([this.settings.get('notifications'), this.settings.get('venue')]);
    return { fromEmail: env.EMAIL_FROM, fromName: prefs.fromName ?? venue.name, replyTo: prefs.replyTo ?? venue.supportEmail ?? venue.email };
  }

  private async attempt(message: EmailMessage): Promise<Delivery> {
    if (!env.SENDGRID_API_KEY) {
      this.logger.log(`Email skipped (SENDGRID_API_KEY not set): "${message.subject}"`);
      return { ok: false, error: NOT_CONFIGURED };
    }
    if (!this.keySet) {
      sendgrid.setApiKey(env.SENDGRID_API_KEY);
      this.keySet = true;
    }
    try {
      const sender = await this.sender();
      await sendgrid.send({
        to: message.to, subject: message.subject, text: message.text,
        from: { email: sender.fromEmail, name: sender.fromName }, replyTo: sender.replyTo,
      });
      return { ok: true };
    } catch (err) {
      const reason = reasonOf(err);
      this.logger.error(`Email failed: "${message.subject}"`, reason);
      return { ok: false, error: reason };
    }
  }
}

/** SendGrid's own message when there is one; never the request or the API key. */
function reasonOf(err: unknown): string {
  const body = (err as { response?: { body?: { errors?: { message?: string }[] } } }).response?.body;
  return body?.errors?.[0]?.message ?? (err instanceof Error ? err.message : 'Unknown error');
}
