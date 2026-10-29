import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import { SlotBlocksService } from './slot-blocks.service.js';
import { SlotEventsService } from './slot-events.service.js';
import { SlotGeneratorService } from './slot-generator.service.js';
import {
  BlockSlotSchema, BulkBlockSchema, BulkSlotsSchema, BulkUnblockSchema, CalendarQuerySchema, GenerateSlotsSchema,
  ListSlotsQuerySchema, type BlockSlotInput, type BulkBlockInput, type BulkSlotsInput, type BulkUnblockInput,
  type CalendarQuery, type GenerateSlotsInput, type ListSlotsQuery,
} from './slots.schemas.js';
import { SlotsService } from './slots.service.js';

/** Dashboard: admins and managers view, block and unblock; only admins generate. */
@Controller('admin/slots')
@UseGuards(AuthGuard)
export class AdminSlotsController {
  constructor(
    private readonly slots: SlotsService,
    private readonly blocks: SlotBlocksService,
    private readonly generator: SlotGeneratorService,
    private readonly events: SlotEventsService,
  ) {}

  @Get()
  list(@Query(new ZodValidationPipe(ListSlotsQuerySchema)) query: ListSlotsQuery) {
    return this.slots.list(query);
  }

  @Get('calendar')
  calendar(@Query(new ZodValidationPipe(CalendarQuerySchema)) query: CalendarQuery) {
    return this.slots.calendar(query);
  }

  @Get(':id')
  get(@Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam) {
    return this.slots.get(id);
  }

  @Get(':id/history')
  history(@Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam) {
    return this.events.history(id);
  }

  @Post('generate')
  @HttpCode(200)
  @Roles('admin')
  generate(@Body(new ZodValidationPipe(GenerateSlotsSchema)) body: GenerateSlotsInput) {
    return this.generator.generate(body);
  }

  /** Block or unblock ticked slots by id; failures are reported per id. */
  @Post('bulk')
  @HttpCode(200)
  bulk(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(BulkSlotsSchema)) body: BulkSlotsInput) {
    return this.blocks.bulkById(user.id, body);
  }

  @Post('block')
  @HttpCode(200)
  bulkBlock(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(BulkBlockSchema)) body: BulkBlockInput) {
    return this.blocks.bulkBlock(user.id, body);
  }

  @Post('unblock')
  @HttpCode(200)
  bulkUnblock(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(BulkUnblockSchema)) body: BulkUnblockInput) {
    return this.blocks.bulkUnblock(user.id, body);
  }

  @Post(':id/block')
  @HttpCode(200)
  block(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(BlockSlotSchema)) body: BlockSlotInput,
  ) {
    return this.blocks.block(user.id, id, body);
  }

  @Post(':id/unblock')
  @HttpCode(200)
  unblock(@CurrentUser() user: AuthUser, @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam) {
    return this.blocks.unblock(user.id, id);
  }
}
