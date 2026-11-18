import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import {
  AdminListGroundsQuerySchema,
  CreateGroundSchema,
  UpdateGroundSchema,
  type AdminListGroundsQuery,
  type CreateGroundInput,
  type UpdateGroundInput,
} from '../grounds/grounds.schemas.js';
import {
  CompleteVenueSchema,
  type CompleteVenueInput,
} from '../settings/venue.schemas.js';
import {
  GenerateSlotsSchema,
  ListSlotsQuerySchema,
  type GenerateSlotsInput,
  type ListSlotsQuery,
} from '../slots/slots.schemas.js';
import { OwnerGroundsService } from './owner-grounds.service.js';
import { OwnerOriginGuard } from './owner-origin.guard.js';
import type { OwnerContext } from './owner-session.js';
import { OwnerSlotsService } from './owner-slots.service.js';
import { OwnerVenueService } from './owner-venue.service.js';
import { CurrentOwner, OwnerGuard } from './owner.guard.js';

@Controller('owner/admin')
@UseGuards(OwnerGuard)
export class OwnerOperationsController {
  constructor(
    private readonly venue: OwnerVenueService,
    private readonly grounds: OwnerGroundsService,
    private readonly slots: OwnerSlotsService,
  ) {}

  @Get('settings/venue')
  getVenue(@CurrentOwner() owner: OwnerContext) {
    return this.venue.get(owner);
  }

  @Put('settings/venue')
  @UseGuards(OwnerOriginGuard)
  saveVenue(
    @CurrentOwner() owner: OwnerContext,
    @Body(new ZodValidationPipe(CompleteVenueSchema)) body: CompleteVenueInput,
  ) {
    return this.venue.update(owner.session, body);
  }

  @Get('grounds')
  listGrounds(
    @CurrentOwner() owner: OwnerContext,
    @Query(new ZodValidationPipe(AdminListGroundsQuerySchema))
    query: AdminListGroundsQuery,
  ) {
    return this.grounds.list(owner, query);
  }

  @Get('grounds/:id')
  getGround(
    @CurrentOwner() owner: OwnerContext,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
  ) {
    return this.grounds.get(owner, id);
  }

  @Post('grounds')
  @UseGuards(OwnerOriginGuard)
  createGround(
    @CurrentOwner() owner: OwnerContext,
    @Body(new ZodValidationPipe(CreateGroundSchema)) body: CreateGroundInput,
  ) {
    return this.grounds.create(owner.session, body);
  }

  @Patch('grounds/:id')
  @UseGuards(OwnerOriginGuard)
  updateGround(
    @CurrentOwner() owner: OwnerContext,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(UpdateGroundSchema)) body: UpdateGroundInput,
  ) {
    return this.grounds.update(owner.session, id, body);
  }

  @Get('slots')
  listSlots(
    @CurrentOwner() owner: OwnerContext,
    @Query(new ZodValidationPipe(ListSlotsQuerySchema)) query: ListSlotsQuery,
  ) {
    return this.slots.list(owner, query);
  }

  @Get('dashboard/today')
  today(@CurrentOwner() owner: OwnerContext) {
    return this.slots.today(owner);
  }

  @Get('dashboard/stats')
  stats(@CurrentOwner() owner: OwnerContext) {
    return this.grounds.stats(owner);
  }

  @Post('slots/generate')
  @UseGuards(OwnerOriginGuard)
  generateSlots(
    @CurrentOwner() owner: OwnerContext,
    @Body(new ZodValidationPipe(GenerateSlotsSchema)) body: GenerateSlotsInput,
  ) {
    return this.slots.generate(owner.session, body);
  }
}
