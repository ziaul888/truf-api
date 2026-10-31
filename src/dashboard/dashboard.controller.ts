import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { DashboardAttentionService } from './dashboard-attention.service.js';
import { DashboardTodayService } from './dashboard-today.service.js';
import { DashboardService } from './dashboard.service.js';

@Controller('admin/dashboard')
@UseGuards(AuthGuard)
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly attentionCards: DashboardAttentionService,
    private readonly todayGrounds: DashboardTodayService,
  ) {}

  @Get('stats')
  stats() {
    return this.dashboard.stats();
  }

  /** Counts for the "needs attention" cards. The frontend refreshes it every 60 seconds. */
  @Get('attention')
  attention() {
    return this.attentionCards.attention();
  }

  /** Today's slots per active ground, with the booking playing now and the next one. */
  @Get('today')
  today() {
    return this.todayGrounds.today();
  }
}
