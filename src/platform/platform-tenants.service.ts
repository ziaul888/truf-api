import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import type { Prisma, TenantStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { withPlatformAvailability } from './platform-availability.js';
import {
  platformTenantSelect,
  toPlatformTenantDto,
} from './platform-tenant.dto.js';
import type { PlatformTenantFilters } from './platform-tenants.schemas.js';

const tenantFilter = (q: PlatformTenantFilters): Prisma.TenantWhereInput => ({
  ...(q.status && { status: q.status }),
  ...(q.search && {
    OR: [
      { name: { contains: q.search, mode: 'insensitive' } },
      { slug: { contains: q.search, mode: 'insensitive' } },
    ],
  }),
});

@Injectable()
export class PlatformTenantsService {
  constructor(private readonly db: PrismaService) {}

  overview() {
    return withPlatformAvailability(async () => {
      const [groups, owners, recent] = await this.overviewRows();
      const counts: Record<TenantStatus, number> = {
        active: 0,
        draft: 0,
        suspended: 0,
        archived: 0,
      };
      for (const group of groups) counts[group.status] = group._count._all;
      return {
        counts: {
          ...counts,
          total: Object.values(counts).reduce((a, b) => a + b, 0),
        },
        owners,
        recentTenants: recent.map(toPlatformTenantDto),
      };
    });
  }

  private overviewRows() {
    return this.db.$transaction([
      this.db.tenant.groupBy({ by: ['status'], _count: { _all: true } }),
      this.db.user.count({
        where: {
          isActive: true,
          tenantMemberships: { some: { isActive: true, role: 'owner' } },
        },
      }),
      this.db.tenant.findMany({
        select: platformTenantSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 6,
      }),
    ]);
  }

  list(query: PlatformTenantFilters) {
    return withPlatformAvailability(async () => {
      const where = tenantFilter(query);
      const [rows, total] = await this.db.$transaction([
        this.db.tenant.findMany({
          where,
          select: platformTenantSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        this.db.tenant.count({ where }),
      ]);
      return {
        data: rows.map(toPlatformTenantDto),
        total,
        page: query.page,
        limit: query.limit,
      };
    });
  }

  detail(id: string) {
    return withPlatformAvailability(async () => {
      const row = await this.db.tenant.findUnique({
        where: { id },
        select: platformTenantSelect,
      });
      if (!row)
        throw new AppError(
          'Turf business not found',
          404,
          'PLATFORM_TENANT_NOT_FOUND',
        );
      return toPlatformTenantDto(row);
    });
  }
}
