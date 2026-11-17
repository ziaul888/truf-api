import { Injectable } from '@nestjs/common';
import type {
  Prisma,
  TenantMembershipRole,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantAccessService } from './tenant-access.service.js';
import type { TenantContext } from './tenant-access.js';
import {
  inTenantTransaction,
  type TenantTransactionRunner,
} from './tenant-transaction.js';

/** Foundation only: not wired to existing single-business services until their RLS rollout. */
@Injectable()
export class TenantDatabaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TenantAccessService,
  ) {}

  run<T>(
    userId: string,
    tenantId: string,
    operation: (
      tx: Prisma.TransactionClient,
      context: TenantContext,
    ) => Promise<T>,
    roles: readonly TenantMembershipRole[] = [],
  ): Promise<T> {
    const run: TenantTransactionRunner<Prisma.TransactionClient> = (work) =>
      this.prisma.$transaction(work);
    return inTenantTransaction(
      run,
      (tx) => this.access.require(userId, tenantId, roles, tx.tenantMembership),
      operation,
    );
  }
}
