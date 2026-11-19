import { Get, Query } from '@nestjs/common';
import { DashboardController } from '../auth/dashboard-controller.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { BookingEventsService } from './booking-events.service.js';
import {
  ListBookingEventsQuerySchema,
  type ListBookingEventsQuery,
} from './bookings.schemas.js';

/** The dashboard's "Recent activity". Admin and manager. */
@DashboardController('booking-events')
export class AdminBookingEventsController {
  constructor(private readonly events: BookingEventsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListBookingEventsQuerySchema))
    q: ListBookingEventsQuery,
  ) {
    return this.events.list(q);
  }
}
