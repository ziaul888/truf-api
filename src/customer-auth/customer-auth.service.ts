import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Customer } from '../generated/prisma/client.js';
import { AppError } from '../common/app-error.js';
import { upsertCustomerByPhone } from '../customers/customer-upsert.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { dashboardData } from '../prisma/dashboard-data-context.js';
import { SmsVerifyService } from '../sms/sms-verify.service.js';
import type { CustomerProfileInput } from './customer-auth.schemas.js';
import {
  toCustomerSession,
  type CustomerJwtPayload,
  type CustomerSession,
} from './customer-auth.types.js';

const unauthenticated = () =>
  new AppError('Please sign in', 401, 'UNAUTHENTICATED');

/**
 * A verified phone identifies bookings, including bookings made as a guest. An email
 * session uses the customer ID and can exist before a phone is linked.
 */
@Injectable()
export class CustomerAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly sms: SmsVerifyService,
  ) {}

  async sendCode(phone: string): Promise<{ sent: true }> {
    await this.sms.send(phone);
    return { sent: true };
  }

  /** `profile`: name and email for a number with no customer record yet; ignored otherwise. */
  async verify(
    phone: string,
    code: string,
    profile?: CustomerProfileInput,
  ): Promise<{ session: CustomerSession; token: string }> {
    await this.verifyPhoneCode(phone, code);
    let customer = await this.prisma.customer.findUnique({ where: { phone } });
    if (profile && (!customer || customer.deletedAt)) {
      await upsertCustomerByPhone(this.prisma, { phone, ...profile }, true);
      customer = await this.prisma.customer.findUnique({ where: { phone } });
    }
    const token = await this.jwt.signAsync({
      sub: phone,
      ver: customer?.sessionVersion ?? 0,
      tenantId: dashboardData.getStore()?.tenantId,
    } satisfies CustomerJwtPayload);
    return { session: toCustomerSession(phone, customer), token };
  }

  async verifyPhoneCode(phone: string, code: string) {
    if (!(await this.sms.check(phone, code))) {
      throw new AppError(
        'That code is wrong or has expired',
        400,
        'INVALID_CODE',
      );
    }
  }

  async issueEmailSession(customer: Customer) {
    const token = await this.jwt.signAsync({
      sub: customer.id,
      ver: customer.sessionVersion,
      tenantId: dashboardData.getStore()?.tenantId,
      method: 'email',
      emailVersion: customer.emailVersion,
    } satisfies CustomerJwtPayload);
    return {
      session: toCustomerSession(customer.phone, customer, true),
      token,
    };
  }

  /** Resolves the cookie to the signed-in customer, or throws 401. */
  async authenticate(token: string | undefined): Promise<CustomerSession> {
    const payload = await this.verifyToken(token);
    if (!payload) throw unauthenticated();
    if (payload.method === 'email') {
      const customer = await this.requireEmailAccount(payload);
      return toCustomerSession(customer.phone, customer, true);
    }
    const customer = await this.prisma.customer.findUnique({
      where: { phone: payload.sub },
    });
    if ((customer?.sessionVersion ?? 0) !== payload.ver)
      throw unauthenticated();
    return toCustomerSession(payload.sub, customer);
  }

  /** Creates or updates the profile for the authenticated identity. */
  async saveProfile(
    session: Pick<CustomerSession, 'phone' | 'customerId' | 'signInMethod'>,
    profile: CustomerProfileInput,
  ): Promise<CustomerSession> {
    if (session.signInMethod === 'email' && session.customerId) {
      const customer = await this.prisma.customer.update({
        where: { id: session.customerId, deletedAt: null },
        data: {
          name: profile.name,
          ...(profile.email && { email: profile.email }),
        },
      });
      return toCustomerSession(customer.phone, customer, true);
    }
    if (!session.phone) throw unauthenticated();
    await upsertCustomerByPhone(
      this.prisma,
      { phone: session.phone, ...profile },
      true,
    );
    const customer = await this.prisma.customer.findUnique({
      where: { phone: session.phone },
    });
    return toCustomerSession(session.phone, customer);
  }

  async emailAccountWithoutPhone(token: string | undefined) {
    const payload = await this.verifyToken(token);
    if (payload?.method !== 'email') throw unauthenticated();
    const customer = await this.requireEmailAccount(payload);
    if (customer.phone) {
      throw new AppError(
        'Your phone number is already verified.',
        409,
        'PHONE_ALREADY_VERIFIED',
      );
    }
    return customer;
  }

  private async requireEmailAccount(
    payload: Extract<CustomerJwtPayload, { method: 'email' }>,
  ) {
    const customer = await this.prisma.customer.findUnique({
      where: {
        id: payload.sub,
        sessionVersion: payload.ver,
        emailVersion: payload.emailVersion,
        deletedAt: null,
      },
    });
    if (!customer?.verifiedEmail) throw unauthenticated();
    return { ...customer, verifiedEmail: customer.verifiedEmail };
  }

  async phoneAccountForEmail(token: string | undefined) {
    const payload = await this.verifyToken(token);
    if (!payload) throw unauthenticated();
    if (payload.method === 'email') {
      throw new AppError(
        'Sign in with your phone to link a sign-in email.',
        403,
        'PHONE_SIGN_IN_REQUIRED',
      );
    }
    const customer = await this.prisma.customer.findUnique({
      where: { phone: payload.sub, deletedAt: null },
    });
    if ((customer?.sessionVersion ?? 0) !== payload.ver)
      throw unauthenticated();
    return customer;
  }

  /** For public routes that behave differently when a customer is signed in. */
  optional(token: string | undefined): Promise<CustomerSession | null> {
    return token
      ? this.authenticate(token).catch(() => null)
      : Promise.resolve(null);
  }

  /** Signs the customer out on every device. A missing or invalid token is a no-op. */
  async logout(token: string | undefined): Promise<void> {
    const payload = await this.verifyToken(token);
    if (!payload) return;
    await this.prisma.customer.updateMany({
      where:
        payload.method === 'email'
          ? {
              id: payload.sub,
              sessionVersion: payload.ver,
              emailVersion: payload.emailVersion,
              deletedAt: null,
            }
          : { phone: payload.sub, sessionVersion: payload.ver },
      data: { sessionVersion: { increment: 1 } },
    });
  }

  private async verifyToken(
    token: string | undefined,
  ): Promise<CustomerJwtPayload | null> {
    if (!token) return null;
    const payload = await this.jwt
      .verifyAsync<CustomerJwtPayload>(token)
      .catch(() => null);
    return payload?.tenantId === dashboardData.getStore()?.tenantId
      ? payload
      : null;
  }
}
