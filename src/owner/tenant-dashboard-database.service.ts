import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { dashboardData } from '../prisma/dashboard-data-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SlotSettings } from '../slots/slots.schemas.js';
import { requireTenantOperator } from './owner-access.js';
import type { OwnerSession, TenantUser } from './owner-session.js';
import {
  assertTurfAdmin,
  configuredVenue,
  requireVenue,
} from './owner-venue.js';
import { tenantSlotSettings } from './tenant-settings.store.js';

@Injectable()
export class TenantDashboardDatabase implements OnModuleDestroy {
  private readonly logger = new Logger(TenantDashboardDatabase.name);
  private connection?: ReturnType<PrismaPg['connect']>;

  constructor(private readonly db: PrismaService) {}

  async runForAdmin<T>(
    session: OwnerSession,
    work: (settings: SlotSettings) => Promise<T>,
  ) {
    const operator = await requireTenantOperator(this.db, session);
    requireVenue(operator);
    assertTurfAdmin(operator);
    return this.run(operator.user.tenant, work);
  }

  async run<T>(
    tenant: Pick<TenantUser['tenant'], 'id' | 'timezone' | 'currency'> & { slug?: string },
    work: (settings: SlotSettings) => Promise<T>,
  ): Promise<T> {
    const [setup, [{ schema }]] = await Promise.all([
      this.db.tenantSetup.findUnique({ where: { tenantId: tenant.id } }),
      this.db.$queryRaw<[{ schema: string }]>`
        SELECT public.provision_turf_dashboard(${tenant.id}) AS schema
      `,
    ]);
    this.connection ??= new PrismaPg(env.DATABASE_URL).connect();
    const pool = (await this.connection).underlyingDriver();
    const client = new PrismaClient({
      adapter: new PrismaPg(pool, { schema }),
    });
    const settings = tenantSlotSettings(setup?.data);
    try {
      return await dashboardData.run(
        {
          client,
          tenantId: tenant.id,
          portalSlug: tenant.slug,
          timezone: tenant.timezone,
          currency: tenant.currency,
          settings,
        },
        work,
        settings,
      );
    } finally {
      await client.$disconnect();
    }
  }

  async onModuleDestroy() {
    if (this.connection) await (await this.connection).dispose();
  }

  async forConfiguredTurfs(
    job: string,
    work: (settings: SlotSettings) => Promise<void>,
  ) {
    const turfs = await this.db.tenant.findMany({
      where: { status: { in: ['draft', 'active'] }, setup: { isNot: null } },
      select: {
        id: true,
        timezone: true,
        currency: true,
        setup: { select: { data: true } },
      },
    });
    for (const turf of turfs) {
      if (!configuredVenue(turf.setup?.data)) continue;
      try {
        await this.run(turf, work);
      } catch (error) {
        this.logger.error(
          `Could not finish ${job} for turf ${turf.id}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }
}
