import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  BookingTokenQuerySchema, CheckoutSchema, MyBookingsQuerySchema,
  type BookingTokenQuery, type CheckoutInput, type MyBookingsQuery,
} from '../bookings/bookings.schemas.js';
import { BookingQueriesService } from '../bookings/booking-queries.service.js';
import { CancelRequestService } from '../bookings/cancel-request.service.js';
import { CheckoutService } from '../bookings/checkout.service.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import { CustomerAuthService } from '../customer-auth/customer-auth.service.js';
import { OwnerOriginGuard } from '../owner/owner-origin.guard.js';
import { TURF_CUSTOMER_COOKIE } from './tenant-customer.controller.js';
import { TenantPortalService } from './tenant-portal.service.js';

@Controller('turfs/:slug')
@UseGuards(OwnerOriginGuard)
export class TenantCheckoutController {
  constructor(
    private readonly portal: TenantPortalService,
    private readonly checkout: CheckoutService,
    private readonly queries: BookingQueriesService,
    private readonly customer: CustomerAuthService,
    private readonly cancelRequests: CancelRequestService,
  ) {}

  @Get('checkout/options')
  options(@Param('slug') slug: string) {
    return this.portal.run(slug, () => this.checkout.options());
  }

  @Post('checkout')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 10 * 60_000 } })
  start(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(CheckoutSchema)) body: CheckoutInput,
  ) {
    return this.portal.run(slug, async () => {
      const session = await this.customer.optional(req.cookies?.[TURF_CUSTOMER_COOKIE]);
      return this.checkout.start(body, session?.phone);
    });
  }

  @Get('customer/bookings')
  mine(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Query(new ZodValidationPipe(MyBookingsQuerySchema)) query: MyBookingsQuery,
  ) {
    return this.portal.run(slug, async () => {
      const session = await this.customer.authenticate(req.cookies?.[TURF_CUSTOMER_COOKIE]);
      return this.queries.listMine(session.phone, query);
    });
  }

  @Get('bookings/:id')
  booking(
    @Param('slug') slug: string,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Query(new ZodValidationPipe(BookingTokenQuerySchema)) { token }: BookingTokenQuery,
  ) {
    return this.portal.run(slug, () => this.queries.getPublic(id, token));
  }

  @Post('bookings/:id/cancel')
  @HttpCode(200)
  cancel(
    @Param('slug') slug: string,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Query(new ZodValidationPipe(BookingTokenQuerySchema)) { token }: BookingTokenQuery,
  ) {
    return this.portal.run(slug, () => this.queries.cancelPublic(id, token));
  }

  @Post('bookings/:id/cancel-request')
  @HttpCode(200)
  requestCancel(
    @Param('slug') slug: string,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Query(new ZodValidationPipe(BookingTokenQuerySchema)) { token }: BookingTokenQuery,
  ) {
    return this.portal.run(slug, async () => {
      await this.cancelRequests.request(id, token);
      return this.queries.getPublic(id, token);
    });
  }
}
