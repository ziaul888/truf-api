import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { TenantDashboardDatabase } from '../owner/tenant-dashboard-database.service.js';
import { configuredVenue } from '../owner/owner-venue.js';
import { turfSettingsOf } from '../owner/tenant-settings.store.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class TenantPortalService {
  constructor(
    private readonly db: PrismaService,
    private readonly dashboard: TenantDashboardDatabase,
  ) {}

  async website(slug: string) {
    const { turf, venue, website } = await this.published(slug);
    const { supportEmail: _privateEmail, ...publicVenue } = venue;
    return {
      ...website,
      venue: {
        ...publicVenue,
        logoUrl: null,
        locale: { timezone: turf.timezone, currency: turf.currency.toUpperCase(), weekStartsOn: 'sat' },
      },
    };
  }

  async defaultPortal(): Promise<{ slug: string | null }> {
    const turfs = await this.db.tenant.findMany({
      where: {
        status: { in: ['draft', 'active'] },
        setup: {
          is: {
            completedAt: { not: null },
            data: { path: ['turfSettings', 'portalPublished'], equals: true },
          },
        },
      },
      select: { slug: true, setup: { select: { data: true } } },
      take: 2,
    });
    const [turf] = turfs;
    return {
      slug: turfs.length === 1 && turf && configuredVenue(turf.setup?.data)
        ? turf.slug
        : null,
    };
  }

  async run<T>(slug: string, work: () => Promise<T>) {
    const { turf } = await this.published(slug);
    return this.dashboard.run(turf, work);
  }

  private async published(slug: string) {
    const turf = await this.db.tenant.findUnique({
      where: { slug, status: { in: ['draft', 'active'] } },
      select: {
        id: true,
        slug: true,
        timezone: true,
        currency: true,
        setup: { select: { data: true } },
      },
    });
    const data = turf?.setup?.data;
    const venue = configuredVenue(data);
    const { portalPublished, website } = turfSettingsOf(data);
    if (!turf || !venue || !portalPublished) {
      throw new AppError('Turf website not found', 404, 'PORTAL_NOT_FOUND');
    }
    return { turf, venue, website };
  }
}
