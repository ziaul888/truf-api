import { Controller, Get, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { PublicClosuresQuerySchema, type PublicClosuresQuery } from './closures.schemas.js';
import { ClosuresService } from './closures.service.js';

/** Public, no sign-in: lets the portal say why days are closed. */
@Controller('closures')
export class PublicClosuresController {
  constructor(private readonly closures: ClosuresService) {}

  @Get()
  list(@Query(new ZodValidationPipe(PublicClosuresQuerySchema)) query: PublicClosuresQuery) {
    return this.closures.listPublic(query);
  }
}
