import { Injectable } from '@nestjs/common';
import { createHmac, randomInt } from 'node:crypto';
import { AppError } from '../common/app-error.js';
import { env } from '../config/env.js';
import { EmailService } from '../email/email.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { dashboardData } from '../prisma/dashboard-data-context.js';

const MAX_ATTEMPTS = 5;
const LIFETIME_MS = 10 * 60_000;
const RESEND_MS = 60_000;

export interface EmailCodeTarget {
  purpose: 'sign-in' | 'link';
  email: string;
  customerId?: string;
  sessionVersion?: number;
  emailVersion?: number;
}

function mac(...values: (string | number | undefined)[]) {
  return createHmac('sha256', env.JWT_SECRET)
    .update(
      JSON.stringify([
        'customer-email',
        dashboardData.getStore()?.tenantId,
        ...values,
      ]),
    )
    .digest('hex');
}

function keyOf(target: EmailCodeTarget) {
  return mac('recipient', target.purpose, target.email);
}

function digestOf(target: EmailCodeTarget, code: string) {
  return mac(
    'code',
    target.purpose,
    target.email,
    target.customerId,
    target.sessionVersion,
    target.emailVersion,
    code,
  );
}

@Injectable()
export class CustomerEmailCodesService {
  constructor(
    private readonly db: PrismaService,
    private readonly email: EmailService,
  ) {}

  assertConfigured() {
    if (!this.email.configured)
      throw new AppError(
        'Email sign-in is unavailable. Continue with your phone number.',
        503,
        'EMAIL_SIGN_IN_UNAVAILABLE',
      );
  }

  async send(target: EmailCodeTarget): Promise<boolean> {
    const now = new Date();
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    const key = keyOf(target);
    const data = {
      digest: digestOf(target, code),
      expiresAt: new Date(now.getTime() + LIFETIME_MS),
      resendAt: new Date(now.getTime() + RESEND_MS),
      attempts: 0,
    };
    const store = this.db.customerEmailCode;
    await store.deleteMany({ where: { expiresAt: { lte: now } } });
    const inserted = await store.createMany({
      data: { key, ...data },
      skipDuplicates: true,
    });
    if (!inserted.count) {
      const renewed = await store.updateMany({
        where: { key, resendAt: { lte: now } },
        data,
      });
      if (!renewed.count) return true;
    }
    const action =
      target.purpose === 'link' ? 'link your email address' : 'sign in';
    const delivered = await this.email.send({
      to: target.email,
      subject: 'Your TurfOrg verification code',
      text: `Use ${code} to ${action}. This code expires in 10 minutes. If you did not request it, you can ignore this message.`,
      kind:
        target.purpose === 'link'
          ? 'customer_email_link'
          : 'customer_email_sign_in',
    });
    if (!delivered)
      await store.deleteMany({ where: { key, digest: data.digest } });
    return delivered;
  }

  /** A successful verification consumes the code atomically. Failed attempts share one budget. */
  async consume(target: EmailCodeTarget, code: string) {
    const where = {
      key: keyOf(target),
      expiresAt: { gt: new Date() },
      attempts: { lt: MAX_ATTEMPTS },
    };
    const valid = await this.db.customerEmailCode.updateMany({
      where: { ...where, digest: digestOf(target, code) },
      data: { attempts: MAX_ATTEMPTS },
    });
    if (valid.count) return true;
    await this.db.customerEmailCode.updateMany({
      where,
      data: { attempts: { increment: 1 } },
    });
    return false;
  }
}
