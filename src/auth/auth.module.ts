import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { env } from '../config/env.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { PermissionsService } from './permissions.service.js';

/** Import this module wherever a controller needs `@UseGuards(AuthGuard)`. */
@Module({
  imports: [
    DiscoveryModule,
    JwtModule.register({
      secret: env.JWT_SECRET,
      signOptions: { expiresIn: env.JWT_TTL_HOURS * 60 * 60, algorithm: 'HS256' },
      verifyOptions: { algorithms: ['HS256'] },
    }),
    // Login only (applied by LoginThrottlerGuard): 5 attempts per minute per IP + email.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 5 }]),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, PermissionsService],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
