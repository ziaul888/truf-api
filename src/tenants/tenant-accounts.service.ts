import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import type { Paginated } from '../common/schemas.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { withTenantAvailability } from './tenant-availability.js';
import {
  tenantAccountSelect,
  toTenantAccountDto,
  type TenantAccountDto,
} from './tenant-account.dto.js';
import type { ListMyTenantAccounts } from './tenant-accounts.schemas.js';

function accountFilter(
  userId: string,
  query: ListMyTenantAccounts,
): Prisma.TenantMembershipWhereInput {
  return {
    userId,
    isActive: true,
    user: { isActive: true },
    tenant: {
      ...(query.status && { status: query.status }),
      ...(query.search && {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { slug: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    },
  };
}

@Injectable()
export class TenantAccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /** V1 owner/staff UI resolves one turf and never chooses an arbitrary membership. */
  mine(userId: string): Promise<TenantAccountDto> {
    return withTenantAvailability(async () => {
      const accounts = await this.prisma.tenantMembership.findMany({
        where: { userId, isActive: true, user: { isActive: true } },
        select: tenantAccountSelect,
        orderBy: { tenantId: 'asc' },
        take: 2,
      });
      if (accounts.length > 1)
        throw new AppError(
          'Your account must be assigned to one turf',
          409,
          'TENANT_ACCOUNT_AMBIGUOUS',
        );
      const account = accounts[0];
      if (!account)
        throw new AppError(
          'Your account has not been assigned to a turf',
          404,
          'TENANT_ACCOUNT_NOT_ASSIGNED',
        );
      return toTenantAccountDto(account);
    });
  }

  list(
    userId: string,
    query: ListMyTenantAccounts,
  ): Promise<Paginated<TenantAccountDto>> {
    const where = accountFilter(userId, query);
    return withTenantAvailability(async () => {
      const [rows, total] = await this.prisma.$transaction([
        this.prisma.tenantMembership.findMany({
          where,
          select: tenantAccountSelect,
          orderBy: [{ tenant: { name: 'asc' } }, { tenantId: 'asc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        this.prisma.tenantMembership.count({ where }),
      ]);
      return {
        data: rows.map(toTenantAccountDto),
        total,
        page: query.page,
        limit: query.limit,
      };
    });
  }

  get(userId: string, tenantId: string): Promise<TenantAccountDto> {
    return withTenantAvailability(async () => {
      const row = await this.prisma.tenantMembership.findFirst({
        where: {
          userId,
          tenantId,
          isActive: true,
          user: { isActive: true },
          tenant: { status: 'active' },
        },
        select: tenantAccountSelect,
      });
      if (!row)
        throw new AppError(
          'You do not have access to this business',
          403,
          'TENANT_ACCESS_DENIED',
        );
      return toTenantAccountDto(row);
    });
  }
}
