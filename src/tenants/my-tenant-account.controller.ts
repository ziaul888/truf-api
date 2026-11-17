import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { TenantAccountsService } from './tenant-accounts.service.js';

@Controller('admin/me/tenant')
@UseGuards(AuthGuard)
export class MyTenantAccountController {
  constructor(private readonly accounts: TenantAccountsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  get(@CurrentUser() user: AuthUser) {
    return this.accounts.mine(user.id);
  }
}
