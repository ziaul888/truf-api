import { Injectable, Logger } from '@nestjs/common';
import sendgrid from '@sendgrid/mail';
import { env } from '../config/env.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Sends plain-text email through SendGrid. Without SENDGRID_API_KEY it logs and skips. Tests mock it. */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private configured = false;

  /** True when the email was handed to SendGrid. Never throws: a failed email must not fail a booking. */
  async send(message: EmailMessage): Promise<boolean> {
    if (!env.SENDGRID_API_KEY) {
      this.logger.log(`Email skipped (SENDGRID_API_KEY not set): "${message.subject}"`);
      return false;
    }
    if (!this.configured) {
      sendgrid.setApiKey(env.SENDGRID_API_KEY);
      this.configured = true;
    }
    try {
      await sendgrid.send({ ...message, from: env.EMAIL_FROM });
      return true;
    } catch (err) {
      this.logger.error(`Email failed: "${message.subject}"`, err instanceof Error ? err.message : String(err));
      return false;
    }
  }
}
