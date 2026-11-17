import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import { RequestIdSchema } from './platform-onboarding.schemas.js';
import { PlatformGuard, CurrentPlatformActor } from './platform.guard.js';
import { PlatformOriginGuard } from './platform-origin.guard.js';
import type { PlatformActor } from './platform-session.js';
import { PlatformOwnerAccessService } from './platform-owner-access.service.js';
@Controller('platform/tenants/:id')
@UseGuards(PlatformGuard, PlatformOriginGuard)
export class PlatformOwnerAccessController {
  constructor(private readonly access: PlatformOwnerAccessService) {}
  @Get('owner-access') state(
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
  ) {
    return this.access.state(id);
  }
  @Post('owner-invitation') invite(
    @CurrentPlatformActor() actor: PlatformActor,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(RequestIdSchema)) input: { requestId: string },
  ) {
    return this.access.invite(actor, id, input.requestId);
  }
}
