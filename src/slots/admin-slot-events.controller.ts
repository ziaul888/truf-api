import { Get, Query } from '@nestjs/common';
import { DashboardController } from '../auth/dashboard-controller.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { SlotEventsService } from './slot-events.service.js';
import {
  ListSlotEventsQuerySchema,
  type ListSlotEventsQuery,
} from './slots.schemas.js';

/** The block / unblock / close / reopen timeline across all slots. Admins and managers. */
@DashboardController('slot-events')
export class AdminSlotEventsController {
  constructor(private readonly events: SlotEventsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListSlotEventsQuerySchema))
    query: ListSlotEventsQuery,
  ) {
    return this.events.list(query);
  }
}
