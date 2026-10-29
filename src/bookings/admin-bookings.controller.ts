import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import { BookingQueriesService } from './booking-queries.service.js';
import {
  CancelBookingSchema, ConfirmBookingSchema, CreateStaffBookingSchema, ListBookingsQuerySchema, RecordPaymentSchema,
  UpcomingQuerySchema, UpdateBookingSchema, type CancelBookingInput, type ConfirmBookingInput, type CreateStaffBookingInput,
  type ListBookingsQuery, type RecordPaymentInput, type UpcomingQuery, type UpdateBookingInput,
} from './bookings.schemas.js';
import { StaffBookingsService } from './staff-bookings.service.js';

/**
 * Dashboard bookings, for admins and managers. Status changes go through the actions
 * (confirm, cancel, payments), never a generic status PATCH, so refunds, slots and emails stay consistent.
 */
@Controller('admin/bookings')
@UseGuards(AuthGuard)
export class AdminBookingsController {
  constructor(
    private readonly queries: BookingQueriesService,
    private readonly staff: StaffBookingsService,
  ) {}

  @Get()
  list(@Query(new ZodValidationPipe(ListBookingsQuerySchema)) query: ListBookingsQuery) {
    return this.queries.list(query);
  }

  @Get('upcoming')
  upcoming(@Query(new ZodValidationPipe(UpcomingQuerySchema)) { limit }: UpcomingQuery) {
    return this.queries.upcoming(limit);
  }

  @Get(':id')
  get(@Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam) {
    return this.queries.get(id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(CreateStaffBookingSchema)) body: CreateStaffBookingInput) {
    return this.staff.create(user.id, body);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(ConfirmBookingSchema)) body: ConfirmBookingInput,
  ) {
    return this.staff.confirm(user.id, id, body);
  }

  /** Also the "Decline" action on the review queue. */
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(CancelBookingSchema)) body: CancelBookingInput,
  ) {
    return this.staff.cancel(user.id, id, body);
  }

  @Post(':id/payments')
  recordPayment(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(RecordPaymentSchema)) body: RecordPaymentInput,
  ) {
    return this.staff.recordPayment(user.id, id, body);
  }

  @Patch(':id')
  update(
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(UpdateBookingSchema)) body: UpdateBookingInput,
  ) {
    return this.staff.update(id, body);
  }

  @Post(':id/resend-confirmation')
  @HttpCode(200)
  resend(@Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam) {
    return this.staff.resendConfirmation(id);
  }
}
