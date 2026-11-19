import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { RequestIdSchema } from './platform-onboarding.schemas.js';
import { PlatformOriginGuard } from './platform-origin.guard.js';
import {
  PaymentInstructionsSchema,
  type PaymentInstructions,
} from './platform-payment-instructions.js';
import { PlatformPaymentInstructionsService } from './platform-payment-instructions.service.js';
import type { PlatformActor } from './platform-session.js';
import { CurrentPlatformActor, PlatformGuard } from './platform.guard.js';

const SavePaymentInstructionsSchema = RequestIdSchema.extend(
  PaymentInstructionsSchema.shape,
);

@Controller('platform/payment-methods')
@UseGuards(PlatformGuard, PlatformOriginGuard)
export class PlatformPaymentInstructionsController {
  constructor(private readonly methods: PlatformPaymentInstructionsService) {}

  @Get()
  get() {
    return this.methods.get();
  }

  @Post()
  @HttpCode(200)
  save(
    @CurrentPlatformActor() actor: PlatformActor,
    @Body(new ZodValidationPipe(SavePaymentInstructionsSchema))
    { requestId, ...data }: PaymentInstructions & { requestId: string },
  ) {
    return this.methods.save(actor, requestId, data);
  }
}
