import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BookingCoreModule } from '../bookings/booking-core.module.js';
import { BookingSeriesBooker } from './booking-series-booker.js';
import { BookingSeriesController } from './booking-series.controller.js';
import { BookingSeriesService } from './booking-series.service.js';

/** Repeat bookings. Exports the booker so the hourly slot job can extend ongoing series after generating slots. */
@Module({
  imports: [AuthModule, BookingCoreModule],
  controllers: [BookingSeriesController],
  providers: [BookingSeriesService, BookingSeriesBooker],
  exports: [BookingSeriesBooker],
})
export class BookingSeriesModule {}
