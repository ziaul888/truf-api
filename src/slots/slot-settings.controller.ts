import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles } from '../auth/auth.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { SlotSettingsService } from './slot-settings.service.js';
import { UpdateSlotSettingsSchema, type UpdateSlotSettingsInput } from './slots.schemas.js';

/** Venue-wide slot settings: admins and managers read, admins save. */
@Controller('admin/settings/slots')
@UseGuards(AuthGuard)
export class SlotSettingsController {
  constructor(private readonly settings: SlotSettingsService) {}

  @Get()
  get() {
    return this.settings.get();
  }

  @Put()
  @Roles('admin')
  update(@Body(new ZodValidationPipe(UpdateSlotSettingsSchema)) body: UpdateSlotSettingsInput) {
    return this.settings.update(body);
  }
}
