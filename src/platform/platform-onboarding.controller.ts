import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { CurrentPlatformActor, PlatformGuard } from './platform.guard.js';
import { PlatformOriginGuard } from './platform-origin.guard.js';
import type { PlatformActor } from './platform-session.js';
import { PlatformOnboardingService } from './platform-onboarding.service.js';
import {
  CreateTurfSchema,
  type CreateTurf,
} from './platform-onboarding.schemas.js';
@Controller('platform/tenants')
@UseGuards(PlatformGuard, PlatformOriginGuard)
export class PlatformOnboardingController {
  constructor(private readonly onboarding: PlatformOnboardingService) {}
  @Post() create(
    @CurrentPlatformActor() actor: PlatformActor,
    @Body(new ZodValidationPipe(CreateTurfSchema)) input: CreateTurf,
  ) {
    return this.onboarding.create(actor, input);
  }
}
