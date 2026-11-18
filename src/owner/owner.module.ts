import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { env } from '../config/env.js';
import { OwnerAuthService } from './owner-auth.service.js';
import { OwnerActivationService } from './owner-activation.service.js';
import { OwnerBillingService } from './owner-billing.service.js';
import { OwnerGuard } from './owner.guard.js';
import { OwnerOriginGuard } from './owner-origin.guard.js';
import { OwnerAuthController } from './owner-auth.controller.js';
import { OwnerBillingController } from './owner-billing.controller.js';
import { ownerSecret, OWNER_AUDIENCE, OWNER_ISSUER } from './owner-session.js';
@Module({
  imports: [
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
  controllers: [OwnerAuthController, OwnerBillingController],
  providers: [
    OwnerAuthService,
    OwnerActivationService,
    OwnerBillingService,
    OwnerGuard,
    OwnerOriginGuard,
  ],
  exports: [OwnerAuthService, OwnerOriginGuard],
})
export class OwnerModule {}
