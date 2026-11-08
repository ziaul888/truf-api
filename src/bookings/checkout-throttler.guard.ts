import { Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions, InjectThrottlerStorage, ThrottlerGuard, type ThrottlerModuleOptions, type ThrottlerStorage,
} from '@nestjs/throttler';
import { AppError } from '../common/app-error.js';
import { CustomerAuthService } from '../customer-auth/customer-auth.service.js';
import { CUSTOMER_COOKIE } from '../customer-auth/customer-cookie.js';
import { normalizePhone } from '../customers/phone.js';

/**
 * Limits checkouts per IP + phone (every request arrives through the Next.js proxy, so the IP
 * alone would be shared). The phone is the signed-in customer's verified one, else the one in
 * the body. Runs before validation, so refused requests count too.
 */
@Injectable()
export class CheckoutThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly customerAuth: CustomerAuthService,
  ) {
    super(options, storageService, reflector);
  }

  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const customer = await this.customerAuth.optional(req.cookies?.[CUSTOMER_COOKIE]);
    const given = typeof req.body?.customerPhone === 'string' ? normalizePhone(req.body.customerPhone) : null;
    return `${req.ip}:${customer?.phone ?? given ?? ''}`;
  }

  protected override async throwThrottlingException(_context: ExecutionContext): Promise<void> {
    throw new AppError('Too many booking attempts. Try again in a few minutes.', 429, 'TOO_MANY_ATTEMPTS');
  }
}
