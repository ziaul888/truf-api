import { Injectable } from '@nestjs/common';
import { deleteImage, imageUrl, saveImage, type UploadedImage } from './settings-images.js';
import { SettingsStore, type SectionMeta } from './settings-store.service.js';
import { toPublicVenue, type PublicVenue } from './venue-settings.service.js';
import type { UpdateWebsiteInput, WebsiteImageSlot, WebsiteStored } from './website.schemas.js';

export type WebsiteDto = WebsiteStored & SectionMeta;
export type PublicWebsite = WebsiteStored & { venue: PublicVenue };

const IMAGE_RULES = { field: 'image', types: ['jpg', 'png', 'webp'] as ('jpg' | 'png' | 'webp')[], maxBytes: 2 * 1024 * 1024, maxLabel: '2 MB', label: 'Images' };

const imagesOf = (w: WebsiteStored) => [w.hero.imageUrl, w.sections.visitUs.imageUrl];

/** The portal's homepage content. Contact details come from the venue profile, not from here. */
@Injectable()
export class WebsiteSettingsService {
  constructor(private readonly store: SettingsStore) {}

  async get(): Promise<WebsiteDto> {
    return this.toDto(await this.store.get('website'));
  }

  /** Each part sent replaces that part; `sections` replaces only the sections it names. */
  async update(input: UpdateWebsiteInput, userId: string): Promise<WebsiteDto> {
    const current = await this.store.get('website');
    const next: WebsiteStored = {
      hero: input.hero ?? current.hero,
      sections: { ...current.sections, ...input.sections },
      social: input.social ?? current.social,
    };
    const saved = await this.store.save('website', next, userId);
    await this.dropUnused(current, saved);
    return this.toDto(saved);
  }

  /** `hero` or `visit`. Saves the file, points the section at it and deletes the previous upload. */
  async uploadImage(slot: WebsiteImageSlot, file: UploadedImage | undefined, userId: string): Promise<WebsiteDto> {
    const url = imageUrl('website', await saveImage('website', file, IMAGE_RULES));
    const current = await this.store.get('website');
    const next = structuredClone(current);
    if (slot === 'hero') next.hero.imageUrl = url;
    else next.sections.visitUs.imageUrl = url;
    const saved = await this.store.save('website', next, userId, 'upload');
    await this.dropUnused(current, saved);
    return this.toDto(saved);
  }

  /** The portal's home page in one request: content plus the public venue profile. Cached for 60 seconds. */
  public(): Promise<PublicWebsite> {
    return this.store.cached('website', async () => {
      const [website, venue] = await Promise.all([this.store.get('website'), this.store.get('venue')]);
      return { ...website, venue: toPublicVenue(venue) };
    });
  }

  /** Uploaded images the new content no longer points at. https links are left alone. */
  private async dropUnused(before: WebsiteStored, after: WebsiteStored) {
    const kept = imagesOf(after);
    for (const url of imagesOf(before)) if (!kept.includes(url)) await deleteImage('website', url);
  }

  private async toDto(website: WebsiteStored): Promise<WebsiteDto> {
    return { ...website, ...(await this.store.meta('website')) };
  }
}
