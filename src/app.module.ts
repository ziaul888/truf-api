import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { BookingsModule } from './bookings/bookings.module.js';
import { CustomerAuthModule } from './customer-auth/customer-auth.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { GroundsModule } from './grounds/grounds.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { SlotsModule } from './slots/slots.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [PrismaModule, HealthModule, AuthModule, UsersModule, GroundsModule, SlotsModule, BookingsModule, CustomersModule, CustomerAuthModule, DashboardModule, ReportsModule, SettingsModule],
})
export class AppModule {}
