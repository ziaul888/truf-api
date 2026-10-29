import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles } from '../auth/auth.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import {
  CreateCustomerSchema, CustomerPhoneQuerySchema, ListCustomersQuerySchema, UpdateCustomerSchema,
  type CreateCustomerInput, type CustomerPhoneQuery, type ListCustomersQuery, type UpdateCustomerInput,
} from './customers.schemas.js';
import { CustomersService } from './customers.service.js';

/** Admins and managers manage customers; only admins delete. */
@Controller('admin/customers')
@UseGuards(AuthGuard)
export class AdminCustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  list(@Query(new ZodValidationPipe(ListCustomersQuerySchema)) query: ListCustomersQuery) {
    return this.customers.list(query);
  }

  /** `{ id, name, phone, email }` or null. */
  @Get('search')
  search(@Query(new ZodValidationPipe(CustomerPhoneQuerySchema)) { phone }: CustomerPhoneQuery) {
    return this.customers.findByPhone(phone);
  }

  @Get(':id')
  get(@Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam) {
    return this.customers.get(id);
  }

  @Post()
  create(@Body(new ZodValidationPipe(CreateCustomerSchema)) body: CreateCustomerInput) {
    return this.customers.create(body);
  }

  @Patch(':id')
  update(
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(UpdateCustomerSchema)) body: UpdateCustomerInput,
  ) {
    return this.customers.update(id, body);
  }

  @Delete(':id')
  @Roles('admin')
  remove(@Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam) {
    return this.customers.remove(id);
  }
}
