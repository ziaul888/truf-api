import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { ResetSettingsSchema, type ResetSettingsInput } from './notifications.schemas.js';
import { SettingsResetService } from './settings-reset.service.js';
import { SystemStatusService } from './system-status.service.js';

/** Read-only payment and system health, and "reset settings to defaults". */
@Controller('admin')
@UseGuards(AuthGuard)
export class AdminSystemController {
  constructor(
    private readonly status: SystemStatusService,
    private readonly resets: SettingsResetService,
  ) {}

  /** Admins and managers: whether Stripe is set up, its mode and the last webhook. Never a key. */
  @Get('settings/payments/status')
  payments() {
    return this.status.payments();
  }

  @Get('system/status')
  @Roles('admin')
  system() {
    return this.status.system();
  }

  /** `{ sections?: ["slots", "notifications", "website"] }`; all three when left out. */
  @Post('settings/reset')
  @HttpCode(200)
  @Roles('admin')
  reset(@Body(new ZodValidationPipe(ResetSettingsSchema)) { sections }: ResetSettingsInput, @CurrentUser() user: AuthUser) {
    return this.resets.reset(sections, user.id);
  }
}
