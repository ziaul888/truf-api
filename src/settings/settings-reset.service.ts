import { Injectable } from '@nestjs/common';
import { DEFAULT_SLOT_SETTINGS, SlotSettingsService } from '../slots/slot-settings.service.js';
import { NotificationSettingsService } from './notification-settings.service.js';
import { SETTINGS_SECTIONS } from './notifications.schemas.js';
import { SettingsStore } from './settings-store.service.js';
import { WebsiteSettingsService } from './website-settings.service.js';

type Section = (typeof SETTINGS_SECTIONS)[number];

/**
 * "Reset settings to defaults" on the System page. Never touches the venue profile, grounds,
 * bookings, customers or payments.
 */
@Injectable()
export class SettingsResetService {
  constructor(
    private readonly store: SettingsStore,
    private readonly slots: SlotSettingsService,
    private readonly notifications: NotificationSettingsService,
    private readonly website: WebsiteSettingsService,
  ) {}

  async reset(sections: readonly Section[] = SETTINGS_SECTIONS, userId: string) {
    const result: Partial<Record<Section, unknown>> = {};
    // Slots first: a notifications reset also sets the two notify flags stored there.
    if (sections.includes('slots')) {
      result.slots = await this.slots.update(DEFAULT_SLOT_SETTINGS);
      await this.store.record('slots', ['*'], userId, 'reset');
    }
    if (sections.includes('notifications')) result.notifications = await this.notifications.reset(userId);
    if (sections.includes('website')) {
      await this.store.reset('website', userId);
      result.website = await this.website.get();
    }
    return result;
  }
}
