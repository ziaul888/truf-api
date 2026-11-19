import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  DEFAULT_NOTIFICATIONS,
  NotificationsStoredSchema,
} from '../settings/notifications.schemas.js';
import { DEFAULT_WEBSITE } from '../settings/website-defaults.js';
import { WebsiteStoredSchema } from '../settings/website.schemas.js';
import { DEFAULT_SLOT_SETTINGS } from '../slots/slot-settings.service.js';
import { SlotSettingsSchema } from '../slots/slots.schemas.js';
import { requireTenantOperator } from './owner-access.js';
import type { OwnerSession, TenantOperator } from './owner-session.js';
import { ownerTransaction } from './owner-transaction.js';
import {
  assertTurfAdmin,
  assertTurfAvailable,
  configuredVenue,
  setupData,
} from './owner-venue.js';

export const TENANT_SLOT_DEFAULTS = {
  ...DEFAULT_SLOT_SETTINGS,
  autoGenerate: false,
};

export function tenantSlotSettings(data: Prisma.JsonValue | undefined) {
  const settings = setupData(setupData(data).turfSettings);
  return (
    SlotSettingsSchema.safeParse(settings.slots).data ?? TENANT_SLOT_DEFAULTS
  );
}

export function turfSettingsOf(data: Prisma.JsonValue | undefined) {
  const settings = setupData(setupData(data).turfSettings);
  return {
    slots: tenantSlotSettings(data),
    website:
      WebsiteStoredSchema.safeParse(settings.website).data ?? DEFAULT_WEBSITE,
    portalPublished: settings.portalPublished === true,
    notifications:
      NotificationsStoredSchema.safeParse(settings.notifications).data ??
      DEFAULT_NOTIFICATIONS,
  };
}

export type TurfSettings = ReturnType<typeof turfSettingsOf>;
type Section = keyof TurfSettings;
type Meta = {
  updatedAt: string | null;
  updatedBy: { id: string; name: string } | null;
};

function metaOf(data: Prisma.JsonValue | undefined, section: Section): Meta {
  const audit = setupData(
    setupData(setupData(data).turfSettingsAudit)[section],
  );
  const { id, name } = setupData(audit.updatedBy);
  return {
    updatedAt: typeof audit.updatedAt === 'string' ? audit.updatedAt : null,
    updatedBy:
      typeof id === 'string' && typeof name === 'string' ? { id, name } : null,
  };
}

function settingsResult(data: Prisma.JsonValue | undefined) {
  return {
    ...turfSettingsOf(data),
    venue: configuredVenue(data),
    meta: (section: Section) => metaOf(data, section),
  };
}

@Injectable()
export class TenantSettingsStore {
  constructor(private readonly db: PrismaService) {}

  async read(operator: TenantOperator) {
    assertTurfAvailable(operator);
    const row = await this.db.tenantSetup.findUnique({
      where: { tenantId: operator.session.tid },
    });
    return settingsResult(row?.data);
  }

  write(
    session: OwnerSession,
    change: (current: TurfSettings) => Partial<TurfSettings>,
  ) {
    return ownerTransaction(this.db, async (tx) => {
      const operator = await requireTenantOperator(tx, session);
      assertTurfAdmin(operator);
      const where = { tenantId: session.tid };
      const row = await tx.tenantSetup.findUnique({ where });
      const updates = change(turfSettingsOf(row?.data));
      const meta = {
        updatedAt: new Date().toISOString(),
        updatedBy: { id: operator.user.id, name: operator.user.name },
      };
      const existing = setupData(row?.data);
      const data = {
        ...existing,
        turfSettings: { ...setupData(existing.turfSettings), ...updates },
        turfSettingsAudit: {
          ...setupData(existing.turfSettingsAudit),
          ...Object.fromEntries(
            Object.keys(updates).map((section) => [section, meta]),
          ),
        },
      };
      const saved = await tx.tenantSetup.upsert({
        where,
        create: { ...where, data },
        update: { data },
      });
      return settingsResult(saved.data);
    });
  }
}
