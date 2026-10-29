import { Controller, Get, Param, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import { PublicSlotsQuerySchema, type PublicSlotsQuery } from './slots.schemas.js';
import { SlotsService } from './slots.service.js';

/** Public, no sign-in: the portal's slot picker. */
@Controller('grounds/:id/slots')
export class PublicSlotsController {
  constructor(private readonly slots: SlotsService) {}

  @Get()
  list(
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Query(new ZodValidationPipe(PublicSlotsQuerySchema)) query: PublicSlotsQuery,
  ) {
    return this.slots.listPublic(id, query);
  }
}
