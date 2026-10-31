import { Injectable } from '@nestjs/common';
import type { ZodType } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DEFAULT_NOTIFICATIONS, NotificationsStoredSchema, type NotificationsStored } from './notifications.schemas.js';
import { changedFields } from './settings-fields.js';
import { DEFAULT_VENUE, VenueStoredSchema, type VenueStored } from './venue.schemas.js';
import { DEFAULT_WEBSITE } from './website-defaults.js';
import { WebsiteStoredSchema, type WebsiteStored } from './website.schemas.js';

export interface SectionData {
  venue: VenueStored;
  website: WebsiteStored;
  notifications: NotificationsStored;
}
export type SectionKey = keyof SectionData;
/** Sections with an audit trail, including the typed slot settings. */
export type AuditedSection = SectionKey | 'slots';

/** Shown under each settings page's title. */
export interface SectionMeta {
  updatedAt: Date | null;
  updatedBy: { id: string; name: string } | null;
}

const SECTIONS: { [K in SectionKey]: { schema: ZodType<SectionData[K]>; defaults: SectionData[K] } } = {
  venue: { schema: VenueStoredSchema, defaults: DEFAULT_VENUE },
  website: { schema: WebsiteStoredSchema, defaults: DEFAULT_WEBSITE },
  notifications: { schema: NotificationsStoredSchema, defaults: DEFAULT_NOTIFICATIONS },
};

const PUBLIC_TTL_MS = 60_000;

/**
 * JSON settings sections, each checked against its schema on the way in and out (a stored value
 * that no longer fits falls back to the defaults). Every write is audited, and clears the
 * 60-second cache behind the public endpoints.
 */
@Injectable()
export class SettingsStore {
  private readonly publicCache = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async get<K extends SectionKey>(key: K): Promise<SectionData[K]> {
    const row = await this.prisma.settingsSection.findUnique({ where: { key } });
    const parsed = row ? SECTIONS[key].schema.safeParse(row.data) : null;
    return parsed?.success ? parsed.data : structuredClone(SECTIONS[key].defaults);
  }

  /** Validates, stores and audits (the changed field names). */
  async save<K extends SectionKey>(key: K, next: SectionData[K], userId: string | null, action = 'update'): Promise<SectionData[K]> {
    const before = await this.get(key);
    await this.put(key, next);
    await this.record(key, changedFields(before, next), userId, action);
    return next;
  }

  /** Validates and stores without an audit row, for callers that audit a wider change themselves. */
  async put<K extends SectionKey>(key: K, next: SectionData[K]): Promise<void> {
    const data = SECTIONS[key].schema.parse(next) as Prisma.InputJsonValue;
    await this.prisma.settingsSection.upsert({ where: { key }, create: { key, data }, update: { data } });
    this.publicCache.clear();
  }

  async reset<K extends SectionKey>(key: K, userId: string | null): Promise<SectionData[K]> {
    return this.save(key, structuredClone(SECTIONS[key].defaults), userId, 'reset');
  }

  /** Audits a change made elsewhere (the slot settings table, uploads). Nothing changed: nothing recorded. */
  async record(section: AuditedSection, fields: string[], userId: string | null, action = 'update'): Promise<void> {
    this.publicCache.clear();
    if (fields.length === 0 && action === 'update') return;
    await this.prisma.settingsEvent.create({ data: { section, fields, action, userId } });
  }

  async meta(section: AuditedSection): Promise<SectionMeta> {
    const last = await this.prisma.settingsEvent.findFirst({
      where: { section }, orderBy: { createdAt: 'desc' }, include: { user: { select: { id: true, name: true } } },
    });
    return { updatedAt: last?.createdAt ?? null, updatedBy: last?.user ?? null };
  }

  /** For public reads: cached for 60 seconds, cleared by any settings write. */
  async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.publicCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;
    const value = await load();
    this.publicCache.set(key, { value, expiresAt: Date.now() + PUBLIC_TTL_MS });
    return value;
  }
}
