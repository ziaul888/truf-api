import type { PrismaService } from '../prisma/prisma.service.js';
import { SettingsStore } from './settings-store.service.js';
import { WebsiteHeroSchema, UpdateWebsiteSchema } from './website.schemas.js';
import { DEFAULT_WEBSITE } from './website-defaults.js';

const hero = { badge: 'B', headline: 'H', description: 'D', imageUrl: 'https://example.com/a.jpg' };
const check = (videoUrl: string) => WebsiteHeroSchema.safeParse({ ...hero, videoUrl });

describe('hero videoUrl', () => {
  it.each(['', 'https://cdn.example.com/a.mp4', 'https://cdn.example.com/a.webm?token=1&x=2', 'https://cdn.example.com/A.MP4'])('accepts %j', (v) => {
    expect(check(v).success).toBe(true);
  });

  it.each([
    'http://cdn.example.com/a.mp4',
    'https://www.youtube.com/watch?v=abc',
    'https://youtu.be/abc',
    'https://vimeo.com/123',
    'https://cdn.example.com/a.mov',
    'https://cdn.example.com/a.mp4/page',
    'not a url',
    `https://cdn.example.com/${'a'.repeat(500)}.mp4`,
  ])('rejects %j', (v) => {
    expect(check(v).success).toBe(false);
  });

  it('says what to use instead of a page link', () => {
    const r = check('https://www.youtube.com/watch?v=abc');
    expect(!r.success && r.error.issues[0]?.message).toBe('Use a direct link to an .mp4 or .webm file');
  });

  it('a hero without videoUrl (old row or old frontend) parses as ""', () => {
    expect(WebsiteHeroSchema.parse(hero).videoUrl).toBe('');
    expect(UpdateWebsiteSchema.parse({ hero }).hero?.videoUrl).toBe('');
  });

  it('a stored website saved before videoUrl keeps its content', async () => {
    const { videoUrl: _omit, ...oldHero } = DEFAULT_WEBSITE.hero;
    const old = { ...DEFAULT_WEBSITE, hero: { ...oldHero, headline: 'Custom' } };
    const prisma = { settingsSection: { findUnique: vi.fn(async () => ({ key: 'website', data: old })) } };
    const got = await new SettingsStore(prisma as unknown as PrismaService).get('website');
    expect(got.hero).toEqual({ ...oldHero, headline: 'Custom', videoUrl: '' });
  });
});
