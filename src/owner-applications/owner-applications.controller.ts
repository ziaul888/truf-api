import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { OwnerOriginGuard } from '../owner/owner-origin.guard.js';
import {
  SubmitOwnerApplicationSchema,
  type SubmitOwnerApplication,
} from './owner-applications.schemas.js';
import { OwnerApplicationsService } from './owner-applications.service.js';

@Controller('owner-applications')
export class OwnerApplicationsController {
  constructor(private readonly applications: OwnerApplicationsService) {}

  @Get('plans')
  plans() {
    return this.applications.plans();
  }

  @Post()
  @UseGuards(OwnerOriginGuard, ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  submit(
    @Body(new ZodValidationPipe(SubmitOwnerApplicationSchema))
    input: SubmitOwnerApplication,
  ) {
    return this.applications.submit(input);
  }
}
