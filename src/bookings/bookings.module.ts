import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module.js';
import { SlotSettingsModule } from '../slots/slot-settings.module.js';
import { AdminBookingsController } from './admin-bookings.controller.js';
import { BookingCoreModule } from './booking-core.module.js';
import { BookingJobs } from './booking-jobs.js';
import { BookingQueriesService } from './booking-queries.service.js';
import { CheckoutService } from './checkout.service.js';
import { CustomerBookingsController } from './customer-bookings.controller.js';
import { PublicBookingsController } from './public-bookings.controller.js';
import { StaffBookingsService } from './staff-bookings.service.js';
import { StripeWebhookService } from './stripe-webhook.service.js';

@Module({
  imports: [AuthModule, CustomerAuthModule, SlotSettingsModule, BookingCoreModule],
  controllers: [AdminBookingsController, PublicBookingsController, CustomerBookingsController],
  providers: [BookingQueriesService, StaffBookingsService, CheckoutService, StripeWebhookService, BookingJobs],
})
export class BookingsModule {}
