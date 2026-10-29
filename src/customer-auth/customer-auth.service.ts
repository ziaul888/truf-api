import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppError } from '../common/app-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SmsVerifyService } from '../sms/sms-verify.service.js';
import { toCustomerSession, type CustomerJwtPayload, type CustomerSession } from './customer-auth.types.js';

const unauthenticated = () => new AppError('Please sign in', 401, 'UNAUTHENTICATED');

/**
 * Customer sign-in by SMS code. The session is keyed on the verified phone, so it works before
 * the customer has a record (their first booking creates it) and shows every booking made with
 * that number, guest bookings included.
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

  async verify(phone: string, code: string): Promise<{ session: CustomerSession; token: string }> {
    if (!(await this.sms.check(phone, code))) {
      throw new AppError('That code is wrong or has expired', 400, 'INVALID_CODE');
    }
    const customer = await this.prisma.customer.findUnique({ where: { phone } });
    const payload: CustomerJwtPayload = { sub: phone, ver: customer?.sessionVersion ?? 0 };
    return { session: toCustomerSession(phone, customer), token: await this.jwt.signAsync(payload) };
  }

  /** Resolves the cookie to the signed-in customer, or throws 401. */
  async authenticate(token: string | undefined): Promise<CustomerSession> {
    const payload = await this.verifyToken(token);
    if (!payload) throw unauthenticated();
    const customer = await this.prisma.customer.findUnique({ where: { phone: payload.sub } });
    if ((customer?.sessionVersion ?? 0) !== payload.ver) throw unauthenticated();
    return toCustomerSession(payload.sub, customer);
  }

  /** For public routes that behave differently when a customer is signed in. */
  optional(token: string | undefined): Promise<CustomerSession | null> {
    return token ? this.authenticate(token).catch(() => null) : Promise.resolve(null);
  }

  /** Signs the customer out on every device. A missing or invalid token is a no-op. */
  async logout(token: string | undefined): Promise<void> {
    const payload = await this.verifyToken(token);
    if (!payload) return;
    await this.prisma.customer.updateMany({
      where: { phone: payload.sub, sessionVersion: payload.ver },
      data: { sessionVersion: { increment: 1 } },
    });
  }

  private async verifyToken(token: string | undefined): Promise<CustomerJwtPayload | null> {
    if (!token) return null;
    return this.jwt.verifyAsync<CustomerJwtPayload>(token).catch(() => null);
  }
}
