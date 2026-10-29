import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import {
  CreateClosureSchema, ListClosuresQuerySchema, type CreateClosureInput, type ListClosuresQuery,
} from './closures.schemas.js';
import { ClosuresService } from './closures.service.js';

/** Venue-wide closures: admins and managers view; only admins close or lift. */
@Controller('admin/closures')
@UseGuards(AuthGuard)
export class AdminClosuresController {
  constructor(private readonly closures: ClosuresService) {}

  @Get()
  list(@Query(new ZodValidationPipe(ListClosuresQuerySchema)) query: ListClosuresQuery) {
    return this.closures.list(query);
  }

  @Post()
  @Roles('admin')
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(CreateClosureSchema)) body: CreateClosureInput) {
    return this.closures.create(user.id, body);
  }

  /** Lifts the closure (the row is kept for history). */
  @Delete(':id')
  @Roles('admin')
  lift(@CurrentUser() user: AuthUser, @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam) {
    return this.closures.lift(user.id, id);
  }
}
