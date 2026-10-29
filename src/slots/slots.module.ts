import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BookingCoreModule } from '../bookings/booking-core.module.js';
import { AdminClosuresController } from './admin-closures.controller.js';
import { AdminSlotEventsController } from './admin-slot-events.controller.js';
import { AdminSlotsController } from './admin-slots.controller.js';
import { ClosuresService } from './closures.service.js';
import { PublicClosuresController } from './public-closures.controller.js';
import { PublicSlotsController } from './public-slots.controller.js';
import { SlotAutoGenerateJob } from './slot-auto-generate.job.js';
import { SlotBlocksService } from './slot-blocks.service.js';
import { SlotEventsService } from './slot-events.service.js';
import { SlotGeneratorService } from './slot-generator.service.js';
import { SlotSettingsController } from './slot-settings.controller.js';
import { SlotSettingsModule } from './slot-settings.module.js';
import { SlotsService } from './slots.service.js';

@Module({
  imports: [AuthModule, SlotSettingsModule, BookingCoreModule],
  controllers: [
    AdminSlotsController, AdminSlotEventsController, AdminClosuresController,
    PublicSlotsController, PublicClosuresController, SlotSettingsController,
  ],
  providers: [
    SlotsService, SlotBlocksService, SlotGeneratorService, SlotEventsService, ClosuresService,
    SlotAutoGenerateJob,
  ],
  exports: [SlotGeneratorService],
})
export class SlotsModule {}
