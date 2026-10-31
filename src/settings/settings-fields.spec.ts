import type { PrismaService } from '../prisma/prisma.service.js';
import { maskEmail } from './notification-settings.service.js';
import { changedFields } from './settings-fields.js';
import { SettingsStore } from './settings-store.service.js';
import { DEFAULT_VENUE } from './venue.schemas.js';

describe('settings helpers', () => {
  it('lists changed leaf paths; arrays count as one field', () => {
    const before = { hero: { headline: 'A', badge: 'B' }, items: [1, 2], social: { facebook: '' } };
    const after = { hero: { headline: 'A2', badge: 'B' }, items: [1, 3], social: { facebook: '' } };
    expect(changedFields(before, after)).toEqual(['hero.headline', 'items']);
    expect(changedFields(before, before)).toEqual([]);
  });

  it('masks email addresses for the log', () => {
    expect(maskEmail('rakib@example.com')).toBe('ra***@example.com');
  });

  it('a stored section that no longer fits its schema falls back to the defaults', async () => {
    const prisma = { settingsSection: { findUnique: vi.fn(async () => ({ key: 'venue', data: { name: 1 } })) } };
    const store = new SettingsStore(prisma as unknown as PrismaService);
    expect(await store.get('venue')).toEqual(DEFAULT_VENUE);
  });

  it('public reads are cached until a write', async () => {
    const prisma = { settingsSection: { upsert: vi.fn(async () => ({})) } };
    const store = new SettingsStore(prisma as unknown as PrismaService);
    const load = vi.fn(async () => 'value');
    await store.cached('k', load);
    await store.cached('k', load);
    expect(load).toHaveBeenCalledTimes(1);
    await store.put('venue', DEFAULT_VENUE);
    await store.cached('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
