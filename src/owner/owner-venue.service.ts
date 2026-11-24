import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  deleteImage,
  LOGO_RULES,
  saveImage,
  type UploadedImage,
} from '../settings/settings-images.js';
import {
  DEFAULT_VENUE,
  type CompleteVenueInput,
} from '../settings/venue.schemas.js';
import { requireTenantOperator } from './owner-access.js';
import type { TenantOperator } from './owner-session.js';
import { ownerTransaction } from './owner-transaction.js';
import {
  assertTurfAdmin,
  assertTurfAvailable,
  configuredVenue,
  setupData,
  turfLogoFolder,
  turfLogoName,
  turfLogoUrl,
} from './owner-venue.js';

function venueDto(
  owner: TenantOperator,
  data: Prisma.JsonValue | undefined,
  updatedAt: Date | null,
) {
  const venue = configuredVenue(data);
  const { logo: _logo, ...defaults } = DEFAULT_VENUE;
  const logoUrl = turfLogoUrl(owner.session.tid, data);
  return {
    ...(venue ?? {
      ...defaults,
      name: owner.user.tenant.name,
      email: owner.user.email,
    }),
    logoUrl,
    locale: {
      currency: owner.user.tenant.currency.toUpperCase(),
      timezone: owner.user.tenant.timezone,
      weekStartsOn: 'sat' as const,
    },
    updatedAt: venue || logoUrl ? updatedAt : null,
    updatedBy: null,
  };
}

@Injectable()
export class OwnerVenueService {
  private readonly logger = new Logger(OwnerVenueService.name);

  constructor(private readonly db: PrismaService) {}

  async get(owner: TenantOperator) {
    assertTurfAvailable(owner);
    const setup = await this.db.tenantSetup.findUnique({
      where: { tenantId: owner.session.tid },
    });
    return venueDto(owner, setup?.data, setup?.updatedAt ?? null);
  }

  update(session: TenantOperator['session'], input: CompleteVenueInput) {
    return ownerTransaction(this.db, async (tx) => {
      const owner = await requireTenantOperator(tx, session);
      assertTurfAvailable(owner);
      const where = { tenantId: session.tid };
      const current = await tx.tenantSetup.findUnique({ where });
      const data = { ...setupData(current?.data), venue: input };
      const completedAt = current?.completedAt ?? new Date();
      const saved = await tx.tenantSetup.upsert({
        where,
        create: { ...where, data, completedAt },
        update: { data, completedAt },
      });
      if (input.name !== owner.user.tenant.name) {
        await tx.tenant.update({
          where: { id: session.tid },
          data: { name: input.name },
        });
      }
      return venueDto(owner, saved.data, saved.updatedAt);
    });
  }

  async uploadLogo(owner: TenantOperator, file: UploadedImage | undefined) {
    assertTurfAdmin(owner);
    const name = await saveImage(
      turfLogoFolder(owner.session.tid),
      file,
      LOGO_RULES,
    );
    return this.setLogo(owner.session, name);
  }

  removeLogo(session: TenantOperator['session']) {
    return this.setLogo(session, null);
  }

  private async setLogo(
    session: TenantOperator['session'],
    name: string | null,
  ) {
    const result = await ownerTransaction(this.db, async (tx) => {
      const owner = await requireTenantOperator(tx, session);
      assertTurfAdmin(owner);
      const where = { tenantId: session.tid };
      const current = await tx.tenantSetup.findUnique({ where });
      const previous = turfLogoName(current?.data);
      if (previous === name)
        return {
          previous,
          venue: venueDto(owner, current?.data, current?.updatedAt ?? null),
        };

      const data = { ...setupData(current?.data), venueLogo: name };
      const saved = await tx.tenantSetup.upsert({
        where,
        create: { ...where, data },
        update: { data },
      });
      return { previous, venue: venueDto(owner, saved.data, saved.updatedAt) };
    }).catch(async (error: unknown) => {
      await this.removeLogoFile(session.tid, name);
      throw error;
    });

    if (result.previous !== name)
      await this.removeLogoFile(session.tid, result.previous);
    return result.venue;
  }

  private async removeLogoFile(tenantId: string, name: string | null) {
    try {
      await deleteImage(turfLogoFolder(tenantId), name);
    } catch (error) {
      this.logger.warn('Could not remove a turf logo file', error);
    }
  }
}
