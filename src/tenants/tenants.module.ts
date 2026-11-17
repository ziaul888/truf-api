import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TenantAccessService } from './tenant-access.service.js';
import { TenantDatabaseService } from './tenant-database.service.js';
import {
  MyTenantAccountsController,
  TenantProfileController,
} from './tenant-accounts.controller.js';
import { TenantAccountsService } from './tenant-accounts.service.js';
import { TenantGuard } from './tenant.guard.js';
import { MyTenantAccountController } from './my-tenant-account.controller.js';

/** Read-only business accounts. Legacy booking services are migrated separately. */
@Module({
  imports: [AuthModule],
  controllers: [
    MyTenantAccountController,
    MyTenantAccountsController,
    TenantProfileController,
  ],
  providers: [
    TenantAccessService,
    TenantDatabaseService,
    TenantGuard,
    TenantAccountsService,
  ],
  exports: [
    AuthModule,
    TenantAccessService,
    TenantDatabaseService,
    TenantGuard,
  ],
})
export class TenantsModule {}
