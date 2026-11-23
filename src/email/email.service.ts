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
  /** A provider error or a missing configuration. */
  error?: string;
}

export interface Sender {
  fromEmail: string;
  fromName: string;
  replyTo: string;
}

const NOT_CONFIGURED =
  'Email is not configured (RESEND_API_KEY or SENDGRID_API_KEY)';

/** Sends plain-text email using the configured provider and logs each delivery attempt. */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private keySet = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsStore,
  ) {}

  get configured(): boolean {
    return Boolean(env.RESEND_API_KEY || env.SENDGRID_API_KEY);
  }

  /** Returns whether the provider accepted the message. */
  async send(message: EmailMessage): Promise<boolean> {
    return (await this.deliver(message)).ok;
  }

  async deliver(message: EmailMessage): Promise<Delivery> {
    const result = await this.attempt(message);
    await this.prisma.emailLog
      .create({
        data: {
          to: message.to,
          subject: message.subject,
          kind: message.kind,
          ok: result.ok,
          error: result.error ?? null,
          bookingId: message.bookingId ?? null,
        },
      })
      .catch((err: unknown) =>
        this.logger.error(
          'Email log failed',
          err instanceof Error ? err.message : String(err),
        ),
      );
    return result;
  }

  /** The from name and reply-to: as set on the Notifications page, else from the venue profile, else the sending address. */
  async sender(): Promise<Sender> {
    const [prefs, venue] = await Promise.all([
      this.settings.get('notifications'),
      this.settings.get('venue'),
    ]);
    return {
      fromEmail: env.EMAIL_FROM,
      fromName: prefs.fromName ?? venue.name,
      replyTo:
        prefs.replyTo ?? venue.supportEmail ?? (venue.email || env.EMAIL_FROM),
    };
  }

  private async attempt(message: EmailMessage): Promise<Delivery> {
    const { RESEND_API_KEY: resendKey, SENDGRID_API_KEY: sendgridKey } = env;
    if (!resendKey && !sendgridKey) {
      this.logger.log(NOT_CONFIGURED);
      return { ok: false, error: NOT_CONFIGURED };
    }
    try {
      const sender = await this.sender();
      if (resendKey) {
        const fromName = sender.fromName.replace(/[\r\n<>]/g, '').trim();
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + resendKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: fromName
              ? fromName + ' <' + sender.fromEmail + '>'
              : sender.fromEmail,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            reply_to: sender.replyTo,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok)
          throw new Error(
            'Resend rejected the email (HTTP ' + response.status + ')',
          );
      } else if (sendgridKey) {
        if (!this.keySet) {
          sendgrid.setApiKey(sendgridKey);
          this.keySet = true;
        }
        await sendgrid.send({
          to: message.to,
          subject: message.subject,
          text: message.text,
          from: { email: sender.fromEmail, name: sender.fromName },
          replyTo: sender.replyTo,
        });
      }
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
  const body = (
    err as { response?: { body?: { errors?: { message?: string }[] } } }
  ).response?.body;
  return (
    body?.errors?.[0]?.message ??
    (err instanceof Error ? err.message : 'Unknown error')
  );
}
