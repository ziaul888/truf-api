import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
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
} from './owner-venue.js';

function venueDto(
  owner: TenantOperator,
  venue: CompleteVenueInput,
  updatedAt: Date | null,
) {
  return {
    ...venue,
    logoUrl: null,
    locale: {
      currency: owner.user.tenant.currency.toUpperCase(),
      timezone: owner.user.tenant.timezone,
      weekStartsOn: 'sat' as const,
    },
    updatedAt,
    updatedBy: null,
  };
}

@Injectable()
export class OwnerVenueService {
  constructor(private readonly db: PrismaService) {}

  async get(owner: TenantOperator) {
    assertTurfAvailable(owner);
    const setup = await this.db.tenantSetup.findUnique({
      where: { tenantId: owner.session.tid },
    });
    const { logo: _logo, ...defaults } = DEFAULT_VENUE;
    const venue = configuredVenue(setup?.data);
    return venueDto(
      owner,
      venue ?? {
        ...defaults,
        name: owner.user.tenant.name,
        email: owner.user.email,
      },
      venue ? (setup?.updatedAt ?? null) : null,
    );
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
      return venueDto(owner, input, saved.updatedAt);
    });
  }
}
