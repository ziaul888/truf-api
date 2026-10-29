import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { SlotEventsService } from './slot-events.service.js';
import { ListSlotEventsQuerySchema, type ListSlotEventsQuery } from './slots.schemas.js';

/** The block / unblock / close / reopen timeline across all slots. Admins and managers. */
@Controller('admin/slot-events')
@UseGuards(AuthGuard)
export class AdminSlotEventsController {
  constructor(private readonly events: SlotEventsService) {}

  @Get()
  list(@Query(new ZodValidationPipe(ListSlotEventsQuerySchema)) query: ListSlotEventsQuery) {
    return this.events.list(query);
  }
}
