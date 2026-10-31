import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EmailModule } from '../email/email.module.js';
import { SlotSettingsModule } from '../slots/slot-settings.module.js';
import { AdminNotificationsController } from './admin-notifications.controller.js';
import { AdminSiteSettingsController } from './admin-site-settings.controller.js';
import { AdminSystemController } from './admin-system.controller.js';
import { NotificationSettingsService } from './notification-settings.service.js';
import { PublicSettingsController } from './public-settings.controller.js';
import { SettingsCoreModule } from './settings-core.module.js';
import { SettingsResetService } from './settings-reset.service.js';
import { SystemStatusService } from './system-status.service.js';
import { VenueSettingsService } from './venue-settings.service.js';
import { WebsiteSettingsService } from './website-settings.service.js';

@Module({
  imports: [AuthModule, SettingsCoreModule, SlotSettingsModule, EmailModule],
  controllers: [AdminSiteSettingsController, AdminNotificationsController, AdminSystemController, PublicSettingsController],
  providers: [VenueSettingsService, WebsiteSettingsService, NotificationSettingsService, SystemStatusService, SettingsResetService],
})
export class SettingsModule {}
