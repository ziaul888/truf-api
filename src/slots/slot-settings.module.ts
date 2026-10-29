import { Module } from '@nestjs/common';
import { SlotSettingsService } from './slot-settings.service.js';

/** Its own module so both slots and bookings can read settings without importing each other. */
@Module({
  providers: [SlotSettingsService],
  exports: [SlotSettingsService],
})
export class SlotSettingsModule {}
