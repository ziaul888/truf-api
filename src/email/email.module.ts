import { Module } from '@nestjs/common';
import { SettingsCoreModule } from '../settings/settings-core.module.js';
import { EmailService } from './email.service.js';

@Module({
  imports: [SettingsCoreModule],
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
