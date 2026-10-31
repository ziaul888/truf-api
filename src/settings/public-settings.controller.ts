import { Controller, Get } from '@nestjs/common';
import { VenueSettingsService } from './venue-settings.service.js';
import { WebsiteSettingsService } from './website-settings.service.js';

/** Public, for the portal. Cached for 60 seconds; a settings save clears it. */
@Controller()
export class PublicSettingsController {
  constructor(
    private readonly venue: VenueSettingsService,
    private readonly website: WebsiteSettingsService,
  ) {}

  @Get('venue')
  getVenue() {
    return this.venue.public();
  }

  /** The homepage content plus `venue`, in one request. */
  @Get('website')
  getWebsite() {
    return this.website.public();
  }
}
