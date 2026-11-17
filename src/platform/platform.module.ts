import { PlatformOwnerAccessController } from './platform-owner-access.controller.js';
import { PlatformOwnerAccessService } from './platform-owner-access.service.js';
import { PlatformCommands } from './platform-command.js';
import { PlatformOnboardingController } from './platform-onboarding.controller.js';
import { PlatformOnboardingService } from './platform-onboarding.service.js';
import { PlatformBillingController } from './platform-billing.controller.js';
import { PlatformBillingReadService } from './platform-billing-read.service.js';
import { PlatformPlansService } from './platform-plans.service.js';
import { PlatformSubscriptionsService } from './platform-subscriptions.service.js';
import { PlatformReceiptsService } from './platform-receipts.service.js';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '../auth/auth.module.js';
import { env } from '../config/env.js';
import { PlatformAuthController } from './platform-auth.controller.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { PlatformGuard } from './platform.guard.js';
import { PlatformOriginGuard } from './platform-origin.guard.js';
import { PlatformTenantsController } from './platform-tenants.controller.js';
import { PlatformTenantsService } from './platform-tenants.service.js';
import {
  PLATFORM_AUDIENCE,
  PLATFORM_ISSUER,
  platformJwtSecret,
} from './platform-session.js';

@Module({
  imports: [
    AuthModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 5 }]),
    JwtModule.register({
      secret: platformJwtSecret,
      signOptions: {
        audience: PLATFORM_AUDIENCE,
        issuer: PLATFORM_ISSUER,
        algorithm: 'HS256',
        expiresIn: env.JWT_TTL_HOURS * 60 * 60,
      },
      verifyOptions: {
        audience: PLATFORM_AUDIENCE,
        issuer: PLATFORM_ISSUER,
        algorithms: ['HS256'],
      },
    }),
  ],
  controllers: [
    PlatformAuthController,
    PlatformTenantsController,
    PlatformOnboardingController,
    PlatformBillingController,
    PlatformOwnerAccessController,
  ],
  providers: [
    PlatformAuthService,
    PlatformGuard,
    PlatformOriginGuard,
    PlatformTenantsService,
    PlatformCommands,
    PlatformOnboardingService,
    PlatformBillingReadService,
    PlatformPlansService,
    PlatformSubscriptionsService,
    PlatformReceiptsService,
    PlatformOwnerAccessService,
  ],
})
export class PlatformModule {}
