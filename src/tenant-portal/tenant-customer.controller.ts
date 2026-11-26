import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import {
  EmailCodeRequestSchema,
  EmailCodeVerifySchema,
  type EmailCodeRequest,
  type EmailCodeVerify,
  CustomerProfileSchema,
  SendCodeSchema,
  VerifyCodeSchema,
  type CustomerProfileInput,
  type SendCodeInput,
  type VerifyCodeInput,
} from '../customer-auth/customer-auth.schemas.js';
import { CustomerEmailAuthService } from '../customer-auth/customer-email-auth.service.js';
import { CustomerAuthService } from '../customer-auth/customer-auth.service.js';
import {
  clearCustomerCookieOptions,
  customerCookieOptions,
} from '../customer-auth/customer-cookie.js';
import { OtpThrottlerGuard } from '../customer-auth/otp-throttler.guard.js';
import { OwnerOriginGuard } from '../owner/owner-origin.guard.js';
import { TenantPortalService } from './tenant-portal.service.js';

export const TURF_CUSTOMER_COOKIE = 'turf_customer_token';
const cookiePath = (slug: string) =>
  `/api/v1/turfs/${encodeURIComponent(slug)}`;

@Controller('turfs/:slug/customer/auth')
@UseGuards(OwnerOriginGuard)
export class TenantCustomerController {
  constructor(
    private readonly portal: TenantPortalService,
    private readonly auth: CustomerAuthService,
    private readonly email: CustomerEmailAuthService,
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
    @Body(new ZodValidationPipe(VerifyCodeSchema))
    { phone, code, linkPhone }: VerifyCodeInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.portal.run(slug, async () => {
      const { session, token } = linkPhone
        ? await this.email.verifyPhoneLink(
            req.cookies?.[TURF_CUSTOMER_COOKIE],
            phone,
            code,
          )
        : await this.auth.verify(phone, code);
      res.cookie(TURF_CUSTOMER_COOKIE, token, {
        ...customerCookieOptions(),
        path: cookiePath(slug),
      });
      return session;
    });
  }

  @Post('email/send-code')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 6, ttl: 10 * 60_000 } })
  sendEmailCode(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(EmailCodeRequestSchema))
    { email }: EmailCodeRequest,
  ) {
    return this.portal.run(slug, () => this.email.sendSignInCode(email));
  }

  @Post('email/verify')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 25, ttl: 10 * 60_000 } })
  verifyEmail(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(EmailCodeVerifySchema))
    { email, code }: EmailCodeVerify,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.portal.run(slug, async () => {
      const { session, token } = await this.email.verifySignInCode(email, code);
      res.cookie(TURF_CUSTOMER_COOKIE, token, {
        ...customerCookieOptions(),
        path: cookiePath(slug),
      });
      return session;
    });
  }

  @Post('email/link/send-code')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 6, ttl: 10 * 60_000 } })
  sendEmailLinkCode(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(EmailCodeRequestSchema))
    { email }: EmailCodeRequest,
  ) {
    return this.portal.run(slug, () =>
      this.email.sendLinkCode(req.cookies?.[TURF_CUSTOMER_COOKIE], email),
    );
  }

  @Post('email/link/verify')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 25, ttl: 10 * 60_000 } })
  verifyEmailLink(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(EmailCodeVerifySchema))
    { email, code }: EmailCodeVerify,
  ) {
    return this.portal.run(slug, () =>
      this.email.verifyLinkCode(
        req.cookies?.[TURF_CUSTOMER_COOKIE],
        email,
        code,
      ),
    );
  }

  @Get('me')
  me(@Param('slug') slug: string, @Req() req: Request) {
    return this.portal.run(slug, () =>
      this.auth.authenticate(req.cookies?.[TURF_CUSTOMER_COOKIE]),
    );
  }

  @Post('profile')
  @HttpCode(200)
  profile(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(CustomerProfileSchema))
    body: CustomerProfileInput,
  ) {
    return this.portal.run(slug, async () => {
      const session = await this.auth.authenticate(
        req.cookies?.[TURF_CUSTOMER_COOKIE],
      );
      return this.auth.saveProfile(session, body);
    });
  }

  @Post('logout')
  @HttpCode(200)
  logout(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.clearCookie(TURF_CUSTOMER_COOKIE, {
      ...clearCustomerCookieOptions(),
      path: cookiePath(slug),
    });
    return this.portal.run(slug, async () => {
      await this.auth.logout(req.cookies?.[TURF_CUSTOMER_COOKIE]);
      return { loggedOut: true };
    });
  }
}
