import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { violatedUniqueIndex } from '../common/prisma-errors.js';
import type { Customer } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CustomerAuthService } from './customer-auth.service.js';
import {
  CustomerEmailCodesService,
  type EmailCodeTarget,
} from './customer-email-codes.service.js';
import { toCustomerSession } from './customer-auth.types.js';

const sent = { sent: true } as const;

function targetOf(
  purpose: EmailCodeTarget['purpose'],
  email: string,
  customer: Customer | null,
): EmailCodeTarget {
  return {
    purpose,
    email,
    ...(customer && {
      customerId: customer.id,
      sessionVersion: customer.sessionVersion,
      emailVersion: customer.emailVersion,
    }),
  };
}

function invalidCode() {
  return new AppError('That code is wrong or has expired', 400, 'INVALID_CODE');
}

@Injectable()
export class CustomerEmailAuthService {
  constructor(
    private readonly db: PrismaService,
    private readonly auth: CustomerAuthService,
    private readonly codes: CustomerEmailCodesService,
  ) {}

  async sendSignInCode(email: string) {
    this.codes.assertConfigured();
    const customer = await this.signInCustomer(email);
    await this.deliver(targetOf('sign-in', email, customer));
    return sent;
  }

  async verifySignInCode(email: string, code: string) {
    const customer = await this.signInCustomer(email);
    if (
      !(await this.codes.consume(targetOf('sign-in', email, customer), code))
    ) {
      throw invalidCode();
    }
    try {
      const account =
        customer ??
        (await this.db.customer.create({
          data: { name: '', email, verifiedEmail: email },
        }));
      return this.auth.issueEmailSession(account);
    } catch (err) {
      if (violatedUniqueIndex(err) !== null) throw invalidCode();
      throw err;
    }
  }

  private async deliver(target: EmailCodeTarget) {
    if (!(await this.codes.send(target))) {
      throw new AppError(
        'The email code could not be sent. Try again shortly.',
        503,
        'EMAIL_CODE_DELIVERY_FAILED',
      );
    }
  }

  async sendLinkCode(token: string | undefined, email: string) {
    this.codes.assertConfigured();
    const customer = await this.linkCustomer(token, email);
    await this.deliver(targetOf('link', email, customer));
    return sent;
  }

  async verifyLinkCode(token: string | undefined, email: string, code: string) {
    const customer = await this.linkCustomer(token, email);
    if (!(await this.codes.consume(targetOf('link', email, customer), code)))
      throw invalidCode();
    try {
      const updated = await this.db.customer.update({
        where: {
          id: customer.id,
          phone: customer.phone,
          email: customer.email,
          sessionVersion: customer.sessionVersion,
          emailVersion: customer.emailVersion,
          deletedAt: null,
        },
        data: { verifiedEmail: email, emailVersion: { increment: 1 } },
      });
      return toCustomerSession(customer.phone, updated);
    } catch (err) {
      if (violatedUniqueIndex(err) !== null) {
        throw new AppError(
          'This email already has an account. Sign in with that email and verify your phone to link your bookings.',
          409,
          'EMAIL_ALREADY_LINKED',
        );
      }
      if ((err as { code?: string })?.code === 'P2025') throw invalidCode();
      throw err;
    }
  }

  async verifyPhoneLink(
    token: string | undefined,
    phone: string,
    code: string,
  ) {
    const account = await this.auth.emailAccountWithoutPhone(token);
    await this.auth.verifyPhoneCode(phone, code);
    try {
      const linked = await this.linkPhone(account, phone);
      return this.auth.issueEmailSession(linked);
    } catch (err) {
      if (
        violatedUniqueIndex(err) !== null ||
        (err as { code?: string })?.code === 'P2025'
      ) {
        throw new AppError(
          'Could not link the phone number. Request a new code and try again.',
          409,
          'PHONE_LINK_CONFLICT',
        );
      }
      throw err;
    }
  }

  private linkPhone(
    account: Customer & { verifiedEmail: string },
    phone: string,
  ) {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.customer.findUnique({ where: { phone } });
      if (existing?.verifiedEmail) {
        throw new AppError(
          'This number already has a sign-in email. Sign in with your phone to use that account.',
          409,
          'PHONE_ALREADY_LINKED',
        );
      }
      const where = {
        id: account.id,
        AND: { phone: null },
        deletedAt: null,
        sessionVersion: account.sessionVersion,
        emailVersion: account.emailVersion,
      };
      if (!existing) return tx.customer.update({ where, data: { phone } });
      await tx.customer.update({
        where,
        data: {
          verifiedEmail: null,
          deletedAt: new Date(),
          sessionVersion: { increment: 1 },
        },
      });
      return tx.customer.update({
        where: { id: existing.id, phone, AND: { verifiedEmail: null } },
        data: {
          verifiedEmail: account.verifiedEmail,
          emailVersion: { increment: 1 },
          email: existing.email ?? account.email,
          name: existing.name || account.name,
          deletedAt: null,
        },
      });
    });
  }

  private signInCustomer(email: string) {
    return this.db.customer.findUnique({
      where: { verifiedEmail: email, deletedAt: null },
    });
  }

  private async linkCustomer(token: string | undefined, email: string) {
    const customer = await this.auth.phoneAccountForEmail(token);
    if (
      !customer ||
      !customer.phone ||
      customer.email?.trim().toLowerCase() !== email
    ) {
      throw new AppError(
        'Save this address in your profile first.',
        400,
        'EMAIL_PROFILE_REQUIRED',
      );
    }
    return { ...customer, phone: customer.phone };
  }
}
