import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { changedFields } from '../settings/settings-fields.js';
import { SettingsStore } from '../settings/settings-store.service.js';
import { SlotSettingsService } from './slot-settings.service.js';
import { UpdateSlotSettingsSchema, type UpdateSlotSettingsInput } from './slots.schemas.js';

/** Venue-wide slot settings: admins and managers read, admins save. */
@Controller('admin/settings/slots')
@UseGuards(AuthGuard)
export class SlotSettingsController {
  constructor(
    private readonly settings: SlotSettingsService,
    private readonly store: SettingsStore,
  ) {}

  /** The settings plus `updatedAt` / `updatedBy` from the audit trail. */
  @Get()
  async get() {
    return { ...(await this.settings.get()), ...(await this.store.meta('slots')) };
  }

  @Put()
  @Roles('admin')
  async update(@Body(new ZodValidationPipe(UpdateSlotSettingsSchema)) body: UpdateSlotSettingsInput, @CurrentUser() user: AuthUser) {
    const before = await this.settings.get();
    const after = await this.settings.update(body);
    await this.store.record('slots', changedFields(before, after), user.id);
    return { ...after, ...(await this.store.meta('slots')) };
  }
}
