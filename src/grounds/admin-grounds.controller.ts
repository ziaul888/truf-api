import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles } from '../auth/auth.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import {
  AdminListGroundsQuerySchema, CreateGroundSchema, UpdateGroundSchema,
  type AdminListGroundsQuery, type CreateGroundInput, type UpdateGroundInput,
} from './grounds.schemas.js';
import { GroundsService } from './grounds.service.js';

/** Dashboard: admins and managers can view; only admins create or edit (prices included). */
@Controller('admin/grounds')
@UseGuards(AuthGuard)
export class AdminGroundsController {
  constructor(private readonly grounds: GroundsService) {}

  @Get()
  list(@Query(new ZodValidationPipe(AdminListGroundsQuerySchema)) query: AdminListGroundsQuery) {
    return this.grounds.list(query);
  }

  @Get(':id')
  get(@Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam) {
    return this.grounds.get(id);
  }

  @Post()
  @Roles('admin')
  create(@Body(new ZodValidationPipe(CreateGroundSchema)) body: CreateGroundInput) {
    return this.grounds.create(body);
  }

  @Patch(':id')
  @Roles('admin')
  update(
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(UpdateGroundSchema)) body: UpdateGroundInput,
  ) {
    return this.grounds.update(id, body);
  }
}
