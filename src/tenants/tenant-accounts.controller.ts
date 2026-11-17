import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { CurrentTenant, TenantGuard } from './tenant.guard.js';
import type { TenantContext } from './tenant-access.js';
import {
  ListMyTenantAccountsSchema,
  type ListMyTenantAccounts,
} from './tenant-accounts.schemas.js';
import { TenantAccountsService } from './tenant-accounts.service.js';

@Controller('admin/me/tenants')
@UseGuards(AuthGuard)
export class MyTenantAccountsController {
  constructor(private readonly accounts: TenantAccountsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(ListMyTenantAccountsSchema))
    query: ListMyTenantAccounts,
  ) {
    return this.accounts.list(user.id, query);
  }
}

@Controller('tenants/:tenantId/profile')
@UseGuards(AuthGuard, TenantGuard)
export class TenantProfileController {
  constructor(private readonly accounts: TenantAccountsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  profile(@CurrentTenant() context: TenantContext) {
    return this.accounts.get(context.userId, context.tenantId);
  }
}
