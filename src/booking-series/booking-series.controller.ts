import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import {
  CreateSeriesSchema, PreviewSeriesSchema, SeriesPaymentRecordSchema, StopSeriesSchema,
  type CreateSeriesInput, type PreviewSeriesInput, type SeriesPaymentRecordInput, type StopSeriesInput,
} from './booking-series.schemas.js';
import { BookingSeriesService } from './booking-series.service.js';

/** Repeat bookings (dashboard), for admins and managers. Each date is a normal booking, managed as usual. */
@Controller('admin/booking-series')
@UseGuards(AuthGuard)
export class BookingSeriesController {
  constructor(private readonly series: BookingSeriesService) {}

  /** Which dates would be booked and which skipped, without saving anything. */
  @Post('preview')
  @HttpCode(200)
  preview(@Body(new ZodValidationPipe(PreviewSeriesSchema)) body: PreviewSeriesInput) {
    return this.series.preview(body);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(CreateSeriesSchema)) body: CreateSeriesInput) {
    return this.series.create(user.id, body);
  }

  @Get(':id')
  get(@Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam) {
    return this.series.get(id);
  }

  @Post(':id/payments')
  recordPayment(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(SeriesPaymentRecordSchema)) body: SeriesPaymentRecordInput,
  ) {
    return this.series.recordPayment(user.id, id, body);
  }

  @Post(':id/stop')
  @HttpCode(200)
  stop(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(StopSeriesSchema)) body: StopSeriesInput,
  ) {
    return this.series.stop(user.id, id, body);
  }
}
