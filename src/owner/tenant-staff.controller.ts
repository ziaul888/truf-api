import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import {
  CreateUserSchema,
  ListUsersQuerySchema,
  ResetPasswordSchema,
  UpdateUserSchema,
  type CreateUserInput,
  type ListUsersQuery,
  type ResetPasswordInput,
  type UpdateUserInput,
} from '../users/users.schemas.js';
import { OwnerOriginGuard } from './owner-origin.guard.js';
import type { TenantOperator } from './owner-session.js';
import {
  CurrentOperator,
  TenantOperatorGuard,
} from './tenant-operator.guard.js';
import { TenantStaffService } from './tenant-staff.service.js';

@Controller('owner/admin/users')
@UseGuards(TenantOperatorGuard)
export class TenantStaffController {
  constructor(private readonly staff: TenantStaffService) {}

  @Get()
  list(
    @CurrentOperator() operator: TenantOperator,
    @Query(new ZodValidationPipe(ListUsersQuerySchema)) query: ListUsersQuery,
  ) {
    return this.staff.list(operator, query);
  }

  @Get(':id')
  get(
    @CurrentOperator() operator: TenantOperator,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
  ) {
    return this.staff.get(operator, id);
  }

  @Post()
  @UseGuards(OwnerOriginGuard)
  create(
    @CurrentOperator() operator: TenantOperator,
    @Body(new ZodValidationPipe(CreateUserSchema)) body: CreateUserInput,
  ) {
    return this.staff.create(operator, body);
  }

  @Patch(':id')
  @UseGuards(OwnerOriginGuard)
  update(
    @CurrentOperator() operator: TenantOperator,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(UpdateUserSchema)) body: UpdateUserInput,
  ) {
    return this.staff.update(operator.session, id, body);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  @UseGuards(OwnerOriginGuard)
  resetPassword(
    @CurrentOperator() operator: TenantOperator,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(ResetPasswordSchema))
    { password }: ResetPasswordInput,
  ) {
    return this.staff.resetPassword(operator, id, password);
  }
}
