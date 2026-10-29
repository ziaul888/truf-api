import { Controller, Get, Param, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import { ListGroundsQuerySchema, type ListGroundsQuery } from './grounds.schemas.js';
import { GroundsService } from './grounds.service.js';

/** Public, no sign-in: the customer booking portal. Active grounds only. */
@Controller('grounds')
export class GroundsController {
  constructor(private readonly grounds: GroundsService) {}

  @Get()
  list(@Query(new ZodValidationPipe(ListGroundsQuerySchema)) query: ListGroundsQuery) {
    return this.grounds.listPublic(query);
  }

  @Get(':id')
  get(@Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam) {
    return this.grounds.getPublic(id);
  }
}
