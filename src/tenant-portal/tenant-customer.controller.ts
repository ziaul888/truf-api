import { Body, Controller, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import {
  CustomerProfileSchema, SendCodeSchema, VerifyCodeSchema,
  type CustomerProfileInput, type SendCodeInput, type VerifyCodeInput,
} from '../customer-auth/customer-auth.schemas.js';
import { CustomerAuthService } from '../customer-auth/customer-auth.service.js';
import { clearCustomerCookieOptions, customerCookieOptions } from '../customer-auth/customer-cookie.js';
import { OtpThrottlerGuard } from '../customer-auth/otp-throttler.guard.js';
import { OwnerOriginGuard } from '../owner/owner-origin.guard.js';
import { TenantPortalService } from './tenant-portal.service.js';

export const TURF_CUSTOMER_COOKIE = 'turf_customer_token';
const cookiePath = (slug: string) => `/api/v1/turfs/${encodeURIComponent(slug)}`;

@Controller('turfs/:slug/customer/auth')
@UseGuards(OwnerOriginGuard)
export class TenantCustomerController {
  constructor(
    private readonly portal: TenantPortalService,
    private readonly auth: CustomerAuthService,
  ) {}

  @Post('send-code')
  @HttpCode(200)
  @UseGuards(OtpThrottlerGuard)
  @Throttle({ default: { limit: 3, ttl: 10 * 60_000 } })
  sendCode(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(SendCodeSchema)) { phone }: SendCodeInput,
  ) {
    return this.portal.run(slug, () => this.auth.sendCode(phone));
  }

  @Post('verify')
  @HttpCode(200)
  @UseGuards(OtpThrottlerGuard)
  verify(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(VerifyCodeSchema)) { phone, code }: VerifyCodeInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.portal.run(slug, async () => {
      const { session, token } = await this.auth.verify(phone, code);
      res.cookie(TURF_CUSTOMER_COOKIE, token, { ...customerCookieOptions(), path: cookiePath(slug) });
      return session;
    });
  }

  @Get('me')
  me(@Param('slug') slug: string, @Req() req: Request) {
    return this.portal.run(slug, () => this.auth.authenticate(req.cookies?.[TURF_CUSTOMER_COOKIE]));
  }

  @Post('profile')
  @HttpCode(200)
  profile(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(CustomerProfileSchema)) body: CustomerProfileInput,
  ) {
    return this.portal.run(slug, async () => {
      const session = await this.auth.authenticate(req.cookies?.[TURF_CUSTOMER_COOKIE]);
      return this.auth.saveProfile(session.phone, body);
    });
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Param('slug') slug: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.clearCookie(TURF_CUSTOMER_COOKIE, { ...clearCustomerCookieOptions(), path: cookiePath(slug) });
    return this.portal.run(slug, async () => {
      await this.auth.logout(req.cookies?.[TURF_CUSTOMER_COOKIE]);
      return { loggedOut: true };
    });
  }
}
