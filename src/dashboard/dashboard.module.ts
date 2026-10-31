import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardAttentionService } from './dashboard-attention.service.js';
import { DashboardTodayService } from './dashboard-today.service.js';
import { DashboardService } from './dashboard.service.js';

@Module({
  imports: [AuthModule],
  controllers: [DashboardController],
  providers: [DashboardService, DashboardAttentionService, DashboardTodayService],
})
export class DashboardModule {}
