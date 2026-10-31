import { Injectable } from '@nestjs/common';
import { env } from '../config/env.js';
import { deleteImage, imageUrl, saveImage, type UploadedImage } from './settings-images.js';
import { SettingsStore, type SectionMeta } from './settings-store.service.js';
import type { UpdateVenueInput, VenueStored } from './venue.schemas.js';

export type PublicVenue = Omit<VenueStored, 'logo' | 'supportEmail'> & {
  logoUrl: string | null;
  /** Fixed in v1. */
  locale: { currency: string; timezone: string; weekStartsOn: 'sat' };
};
export type VenueDto = PublicVenue & { supportEmail: string | null } & SectionMeta;

const LOGO_RULES = { field: 'logo', types: ['png', 'jpg'] as ('png' | 'jpg')[], maxBytes: 200 * 1024, maxLabel: '200 KB', label: 'The logo' };

export function toPublicVenue({ logo, supportEmail: _support, ...rest }: VenueStored): PublicVenue {
  return {
    ...rest,
    logoUrl: logo ? imageUrl('venue', logo) : null,
    locale: { currency: env.CURRENCY.toUpperCase(), timezone: env.VENUE_TIMEZONE, weekStartsOn: 'sat' },
  };
}

/**
 * The venue profile: one set of contact details for the portal header and footer, the website's
 * "Visit us" block and emails. Edited on Settings → General.
 */
@Injectable()
export class VenueSettingsService {
  constructor(private readonly store: SettingsStore) {}

  async get(): Promise<VenueDto> {
    return this.toDto(await this.store.get('venue'));
  }

  async update(input: UpdateVenueInput, userId: string): Promise<VenueDto> {
    const current = await this.store.get('venue');
    return this.toDto(await this.store.save('venue', { ...current, ...input }, userId));
  }

  /** PNG or JPG only (no SVG: it can carry scripts), up to 200 KB. Replaces and deletes the old one. */
  async uploadLogo(file: UploadedImage | undefined, userId: string): Promise<VenueDto> {
    const name = await saveImage('venue', file, LOGO_RULES);
    const current = await this.store.get('venue');
    const saved = await this.store.save('venue', { ...current, logo: name }, userId, 'upload');
    await deleteImage('venue', current.logo);
    return this.toDto(saved);
  }

  async removeLogo(userId: string): Promise<VenueDto> {
    const current = await this.store.get('venue');
    const saved = await this.store.save('venue', { ...current, logo: null }, userId);
    await deleteImage('venue', current.logo);
    return this.toDto(saved);
  }

  /** The portal's copy: no support email or audit fields. Cached for 60 seconds. */
  public(): Promise<PublicVenue> {
    return this.store.cached('venue', async () => toPublicVenue(await this.store.get('venue')));
  }

  private async toDto(venue: VenueStored): Promise<VenueDto> {
    return { ...toPublicVenue(venue), supportEmail: venue.supportEmail, ...(await this.store.meta('venue')) };
  }
}
