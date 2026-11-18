import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { BookingSeriesModule } from './booking-series/booking-series.module.js';
import { BookingsModule } from './bookings/bookings.module.js';
import { CustomerAuthModule } from './customer-auth/customer-auth.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { GroundsModule } from './grounds/grounds.module.js';
import { HealthModule } from './health/health.module.js';
import { OwnerApplicationsModule } from './owner-applications/owner-applications.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { SlotsModule } from './slots/slots.module.js';
import { TenantsModule } from './tenants/tenants.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    PrismaModule,
    HealthModule,
    AuthModule,
    OwnerApplicationsModule,
    UsersModule,
    GroundsModule,
    SlotsModule,
    BookingsModule,
    BookingSeriesModule,
    CustomersModule,
    CustomerAuthModule,
    DashboardModule,
    ReportsModule,
    SettingsModule,
    TenantsModule,
    PlatformModule,
  ],
})
export class AppModule {}
