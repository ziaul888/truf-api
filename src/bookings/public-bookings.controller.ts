import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../common/app-error.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import { CustomerAuthService } from '../customer-auth/customer-auth.service.js';
import { CUSTOMER_COOKIE } from '../customer-auth/customer-cookie.js';
import { BookingQueriesService } from './booking-queries.service.js';
import { BookingTokenQuerySchema, CheckoutSchema, type BookingTokenQuery, type CheckoutInput } from './bookings.schemas.js';
import { CheckoutService } from './checkout.service.js';
import { StripeWebhookService } from './stripe-webhook.service.js';

/** Public, no sign-in: portal checkout, the signed booking link, and Stripe's webhook. */
@Controller()
export class PublicBookingsController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly queries: BookingQueriesService,
    private readonly webhook: StripeWebhookService,
    private readonly customerAuth: CustomerAuthService,
  ) {}

  /** Whether "pay at the venue" is offered, and the service fee to show. */
  @Get('checkout/options')
  options() {
    return this.checkout.options();
  }

  /**
   * Card: send the customer to `checkoutUrl` (Stripe). Cash: `checkoutUrl` is null; show
   * `confirmationUrl` (the booking is pending until staff confirm). Signed in, the booking
   * goes on the customer's verified phone.
   */
  @Post('checkout')
  async start(@Body(new ZodValidationPipe(CheckoutSchema)) body: CheckoutInput, @Req() req: Request) {
    const customer = await this.customerAuth.optional(req.cookies?.[CUSTOMER_COOKIE]);
    return this.checkout.start(body, customer?.phone);
  }

  @Post('bookings/:id/checkout')
  @HttpCode(200)
  resume(
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Query(new ZodValidationPipe(BookingTokenQuerySchema)) { token }: BookingTokenQuery,
  ) {
    return this.checkout.resume(id, token);
  }

  /** "Pay now": a Stripe link for what's still due on the booking. `409 NOTHING_DUE` when paid up. */
  @Post('bookings/:id/pay')
  @HttpCode(200)
  pay(
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Query(new ZodValidationPipe(BookingTokenQuerySchema)) { token }: BookingTokenQuery,
  ) {
    return this.checkout.payDue(id, token);
  }

  @Get('bookings/:id')
  get(
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Query(new ZodValidationPipe(BookingTokenQuerySchema)) { token }: BookingTokenQuery,
  ) {
    return this.queries.getPublic(id, token);
  }

  @Post('bookings/:id/cancel')
  @HttpCode(200)
  cancel(
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Query(new ZodValidationPipe(BookingTokenQuerySchema)) { token }: BookingTokenQuery,
  ) {
    return this.queries.cancelPublic(id, token);
  }

  /** The raw body is kept for this route only (see app.setup.ts), for the signature check. */
  @Post('stripe/webhook')
  @HttpCode(200)
  stripeWebhook(@Headers('stripe-signature') signature: string | undefined, @Body() body: unknown) {
    if (!Buffer.isBuffer(body)) throw new AppError('Expected the raw Stripe payload', 400, 'INVALID_SIGNATURE');
    return this.webhook.handle(body, signature);
  }
}
