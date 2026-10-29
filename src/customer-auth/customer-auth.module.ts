import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { env } from '../config/env.js';
import { SmsModule } from '../sms/sms.module.js';
import { CustomerAuthController } from './customer-auth.controller.js';
import { CustomerAuthGuard } from './customer-auth.guard.js';
import { CustomerAuthService } from './customer-auth.service.js';

/**
 * Customer tokens are signed with a key derived from JWT_SECRET, so a staff token is never
 * accepted as a customer token or the other way round. (ThrottlerModule is global, from AuthModule.)
 */
@Module({
  imports: [
    SmsModule,
    JwtModule.register({
      secret: `${env.JWT_SECRET}:customer`,
      signOptions: { expiresIn: env.CUSTOMER_SESSION_DAYS * 24 * 60 * 60, algorithm: 'HS256', audience: 'customer' },
      verifyOptions: { algorithms: ['HS256'], audience: 'customer' },
    }),
  ],
  controllers: [CustomerAuthController],
  providers: [CustomerAuthService, CustomerAuthGuard],
  exports: [CustomerAuthService, CustomerAuthGuard],
})
export class CustomerAuthModule {}
