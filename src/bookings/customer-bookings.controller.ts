import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { CurrentCustomer, CustomerAuthGuard } from '../customer-auth/customer-auth.guard.js';
import type { CustomerSession } from '../customer-auth/customer-auth.types.js';
import { BookingQueriesService } from './booking-queries.service.js';
import { MyBookingsQuerySchema, type MyBookingsQuery } from './bookings.schemas.js';

/** "My bookings" for a signed-in customer. View, cancel and pay go through each booking's signed link. */
@Controller('customer/bookings')
@UseGuards(CustomerAuthGuard)
export class CustomerBookingsController {
  constructor(private readonly queries: BookingQueriesService) {}

  @Get()
  list(@CurrentCustomer() customer: CustomerSession, @Query(new ZodValidationPipe(MyBookingsQuerySchema)) q: MyBookingsQuery) {
    return this.queries.listMine(customer.phone, q);
  }
}
