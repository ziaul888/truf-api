import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import {
  CreateUserSchema, ListUsersQuerySchema, ResetPasswordSchema, UpdateUserSchema,
  type CreateUserInput, type ListUsersQuery, type ResetPasswordInput, type UpdateUserInput,
} from './users.schemas.js';
import { UsersService } from './users.service.js';

/** Staff accounts. Admins only — managers change their own password via /admin/auth. */
@Controller('admin/users')
@UseGuards(AuthGuard)
@Roles('admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@Query(new ZodValidationPipe(ListUsersQuerySchema)) query: ListUsersQuery) {
    return this.users.list(query);
  }

  @Get(':id')
  get(@Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam) {
    return this.users.get(id);
  }

  @Post()
  create(@Body(new ZodValidationPipe(CreateUserSchema)) body: CreateUserInput) {
    return this.users.create(body);
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: AuthUser,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(UpdateUserSchema)) body: UpdateUserInput,
  ) {
    return this.users.update(actor.id, id, body);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(ResetPasswordSchema)) body: ResetPasswordInput,
  ) {
    return this.users.resetPassword(id, body);
  }
}
