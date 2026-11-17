import { Injectable } from '@nestjs/common';
import type { TenantMembershipRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { withTenantAvailability } from './tenant-availability.js';
import { resolveTenantAccess, type MembershipReader } from './tenant-access.js';

@Injectable()
export class TenantAccessService {
  constructor(private readonly prisma: PrismaService) {}

  require(
    userId: string,
    tenantId: string,
    roles: readonly TenantMembershipRole[] = [],
    reader: MembershipReader = this.prisma.tenantMembership,
  ) {
    return withTenantAvailability(() =>
      resolveTenantAccess(reader, userId, tenantId, roles),
    );
  }
}
