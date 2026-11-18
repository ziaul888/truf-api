import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { PlatformGuard, CurrentPlatformActor } from './platform.guard.js';
import { PlatformOriginGuard } from './platform-origin.guard.js';
import type { PlatformActor } from './platform-session.js';
import {
  PlatformApplicationFiltersSchema,
  ReviewApplicationSchema,
  type PlatformApplicationFilters,
  type ReviewApplication,
} from './platform-applications.schemas.js';
import { PlatformApplicationsService } from './platform-applications.service.js';

@Controller('platform/applications')
@UseGuards(PlatformGuard, PlatformOriginGuard)
export class PlatformApplicationsController {
  constructor(private readonly applications: PlatformApplicationsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(PlatformApplicationFiltersSchema))
    filters: PlatformApplicationFilters,
  ) {
    return this.applications.list(filters);
  }

  @Post(':id/activate')
  activate(
    @CurrentPlatformActor() actor: PlatformActor,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(ReviewApplicationSchema))
    input: ReviewApplication,
  ) {
    return this.applications.activate(actor, id, input.requestId);
  }

  @Post(':id/reject')
  reject(
    @CurrentPlatformActor() actor: PlatformActor,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(ReviewApplicationSchema))
    input: ReviewApplication,
  ) {
    return this.applications.reject(actor, id, input.requestId);
  }
}
