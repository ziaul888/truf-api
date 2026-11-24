import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PermissionsService } from '../auth/permissions.service.js';
import { env } from '../config/env.js';
import { GroundPhotosModule } from '../grounds/ground-photos.module.js';
import { OwnerAuthService } from './owner-auth.service.js';
import { OwnerActivationService } from './owner-activation.service.js';
import { OwnerBillingService } from './owner-billing.service.js';
import { OwnerGuard } from './owner.guard.js';
import { OwnerOriginGuard } from './owner-origin.guard.js';
import { OwnerAuthController } from './owner-auth.controller.js';
import { OwnerBillingController } from './owner-billing.controller.js';
import { OwnerOperationsController } from './owner-operations.controller.js';
import { TenantDashboardDatabase } from './tenant-dashboard-database.service.js';
import { OwnerGroundPhotosController } from './owner-ground-photos.controller.js';
import { OwnerGroundsService } from './owner-grounds.service.js';
import { OwnerSlotsService } from './owner-slots.service.js';
import { TenantSlotWindowJob } from './tenant-slot-window.job.js';
import { OwnerVenueService } from './owner-venue.service.js';
import { TenantOperatorGuard } from './tenant-operator.guard.js';
import { TenantStaffController } from './tenant-staff.controller.js';
import { TenantStaffService } from './tenant-staff.service.js';
import { TenantSettingsController } from './tenant-settings.controller.js';
import { TenantSettingsService } from './tenant-settings.service.js';
import { TenantSettingsStore } from './tenant-settings.store.js';
import { ownerSecret, OWNER_AUDIENCE, OWNER_ISSUER } from './owner-session.js';
@Module({
  imports: [
    DiscoveryModule,
    GroundPhotosModule,
    JwtModule.register({
      secret: ownerSecret,
      signOptions: {
        algorithm: 'HS256',
        audience: OWNER_AUDIENCE,
        issuer: OWNER_ISSUER,
        expiresIn: env.JWT_TTL_HOURS * 3600,
      },
      verifyOptions: {
        algorithms: ['HS256'],
        audience: OWNER_AUDIENCE,
        issuer: OWNER_ISSUER,
      },
    }),
  ],
  controllers: [
    OwnerAuthController,
    OwnerBillingController,
    OwnerOperationsController,
    OwnerGroundPhotosController,
    TenantStaffController,
    TenantSettingsController,
  ],
  providers: [
    PermissionsService,
    OwnerAuthService,
    OwnerActivationService,
    OwnerBillingService,
    TenantDashboardDatabase,
    OwnerGroundsService,
    OwnerSlotsService,
    TenantSlotWindowJob,
    OwnerVenueService,
    TenantStaffService,
    TenantSettingsService,
    TenantSettingsStore,
    TenantOperatorGuard,
    OwnerGuard,
    OwnerOriginGuard,
  ],
  exports: [OwnerAuthService, OwnerOriginGuard, TenantDashboardDatabase],
})
export class OwnerModule {}
