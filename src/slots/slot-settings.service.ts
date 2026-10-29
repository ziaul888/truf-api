import { Injectable } from '@nestjs/common';
import type { SlotSettings as SlotSettingsRow } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SlotSettings, UpdateSlotSettingsInput } from './slots.schemas.js';

/** Used until an admin saves the settings page for the first time. */
export const DEFAULT_SLOT_SETTINGS: SlotSettings = {
  advanceBookingDays: 30,
  autoGenerate: true,
  cancellationCutoffHours: 2,
  notifyCustomerOnBlock: true,
  notifyAdminOnBooking: false,
  holdMinutes: 15,
  serviceFee: 5000,
  portalCashEnabled: true,
};

/** The single venue-wide row (id = 1). */
const SETTINGS_ID = 1;

const toSettings = (row: SlotSettingsRow): SlotSettings => ({
  advanceBookingDays: row.advanceBookingDays,
  autoGenerate: row.autoGenerate,
  cancellationCutoffHours: row.cancellationCutoffHours,
  notifyCustomerOnBlock: row.notifyCustomerOnBlock,
  notifyAdminOnBooking: row.notifyAdminOnBooking,
  holdMinutes: row.holdMinutes,
  serviceFee: row.serviceFee,
  portalCashEnabled: row.portalCashEnabled,
});

@Injectable()
export class SlotSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<SlotSettings> {
    const row = await this.prisma.slotSettings.findUnique({ where: { id: SETTINGS_ID } });
    return row ? toSettings(row) : DEFAULT_SLOT_SETTINGS;
  }

  async update(input: UpdateSlotSettingsInput): Promise<SlotSettings> {
    const row = await this.prisma.slotSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { ...DEFAULT_SLOT_SETTINGS, ...input, id: SETTINGS_ID },
      update: input,
    });
    return toSettings(row);
  }
}
