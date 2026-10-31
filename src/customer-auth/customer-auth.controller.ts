import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { CUSTOMER_COOKIE, clearCustomerCookieOptions, customerCookieOptions } from './customer-cookie.js';
import { CurrentCustomer, CustomerAuthGuard } from './customer-auth.guard.js';
import {
  CustomerProfileSchema, SendCodeSchema, VerifyCodeSchema, type CustomerProfileInput, type SendCodeInput, type VerifyCodeInput,
} from './customer-auth.schemas.js';
import { CustomerAuthService } from './customer-auth.service.js';
import type { CustomerSession } from './customer-auth.types.js';
import { OtpThrottlerGuard } from './otp-throttler.guard.js';

/** Customer sign-in on the portal: phone → SMS code → `customer_token` cookie. */
@Controller('customer/auth')
export class CustomerAuthController {
  constructor(private readonly auth: CustomerAuthService) {}

  /** 3 codes per 10 minutes per IP + phone. */
  @Post('send-code')
  @HttpCode(200)
  @UseGuards(OtpThrottlerGuard)
  @Throttle({ default: { limit: 3, ttl: 10 * 60_000 } })
  sendCode(@Body(new ZodValidationPipe(SendCodeSchema)) { phone }: SendCodeInput) {
    return this.auth.sendCode(phone);
  }

  /** 5 tries per minute per IP + phone. */
  @Post('verify')
  @HttpCode(200)
  @UseGuards(OtpThrottlerGuard)
  async verify(
    @Body(new ZodValidationPipe(VerifyCodeSchema)) { phone, code, name, email }: VerifyCodeInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerSession> {
    const { session, token } = await this.auth.verify(phone, code, name && email ? { name, email } : undefined);
    res.cookie(CUSTOMER_COOKIE, token, customerCookieOptions());
    return session;
  }

  @Get('me')
  @UseGuards(CustomerAuthGuard)
  me(@CurrentCustomer() customer: CustomerSession): CustomerSession {
    return customer;
  }

  /** Completes sign-up for a new number (`needsProfile`), or changes name and email. */
  @Post('profile')
  @HttpCode(200)
  @UseGuards(CustomerAuthGuard)
  saveProfile(
    @CurrentCustomer() customer: CustomerSession,
    @Body(new ZodValidationPipe(CustomerProfileSchema)) body: CustomerProfileInput,
  ): Promise<CustomerSession> {
    return this.auth.saveProfile(customer.phone, body);
  }

  /** No guard: works with an expired token. Signs the customer out on every device. */
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[CUSTOMER_COOKIE]);
    res.clearCookie(CUSTOMER_COOKIE, clearCustomerCookieOptions());
    return { loggedOut: true };
  }
}
