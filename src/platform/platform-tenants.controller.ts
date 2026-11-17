import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { PlatformGuard } from './platform.guard.js';
import { PlatformTenantsService } from './platform-tenants.service.js';
import {
  PlatformTenantFiltersSchema,
  type PlatformTenantFilters,
} from './platform-tenants.schemas.js';

@Controller('platform')
@UseGuards(PlatformGuard)
export class PlatformTenantsController {
  constructor(private readonly tenants: PlatformTenantsService) {}
  @Get('overview') overview() {
    return this.tenants.overview();
  }
  @Get('tenants') list(
    @Query(new ZodValidationPipe(PlatformTenantFiltersSchema))
    query: PlatformTenantFilters,
  ) {
    return this.tenants.list(query);
  }
  @Get('tenants/:id') detail(
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
  ) {
    return this.tenants.detail(id);
  }
}
