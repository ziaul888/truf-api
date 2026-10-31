import { Module } from '@nestjs/common';
import { SettingsStore } from './settings-store.service.js';
import { SystemStateService } from './system-state.service.js';

/** The settings store on its own, so email and bookings can read settings without the controllers. */
@Module({
  providers: [SettingsStore, SystemStateService],
  exports: [SettingsStore, SystemStateService],
})
export class SettingsCoreModule {}
