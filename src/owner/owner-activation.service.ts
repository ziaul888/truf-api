import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppError } from '../common/app-error.js';
import { hashPassword } from '../auth/password.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ownerMembershipSelect } from './owner-access.js';
import { invitationHash } from './owner-invitation-token.js';
import { ownerTransaction } from './owner-transaction.js';
import type { AcceptOwnerInvitation } from './owner-activation.schemas.js';
const invalid = () =>
  new AppError(
    'This activation link has expired or is no longer available. Ask your platform administrator for a new link, or sign in if you already activated your account.',
    400,
    'OWNER_INVITATION_INVALID',
  );
async function validInvitation(tx: Prisma.TransactionClient, token: string) {
  const row = await tx.ownerInvitation.findUnique({
    where: { tokenHash: invitationHash(token) },
    include: { membership: { select: ownerMembershipSelect } },
  });
  if (!row || row.revokedAt || row.consumedAt || row.expiresAt <= new Date())
    throw invalid();
  const m = row.membership;
  if (
    !m.isActive ||
    m.role !== 'owner' ||
    m.user.isActive ||
    m.user.legacyStaffAccess ||
    m.user.tokenVersion !== row.userVersion ||
    m.tokenVersion !== row.membershipVersion ||
    !['draft', 'active'].includes(m.tenant.status)
  )
    throw invalid();
  return row;
}
@Injectable()
export class OwnerActivationService {
  constructor(private readonly db: PrismaService) {}
  async preview(token: string) {
    const row = await validInvitation(this.db, token);
    return {
      ownerName: row.membership.user.name,
      email: row.membership.user.email,
      turfName: row.membership.tenant.name,
      expiresAt: row.expiresAt.toISOString(),
    };
  }
  async accept(input: AcceptOwnerInvitation) {
    const passwordHash = await hashPassword(input.password);
    return ownerTransaction(this.db, async (tx) => {
      const row = await validInvitation(tx, input.token);
      const claimed = await tx.ownerInvitation.updateMany({
        where: {
          id: row.id,
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      if (claimed.count !== 1) throw invalid();
      const user = await tx.user.updateMany({
        where: {
          id: row.userId,
          isActive: false,
          legacyStaffAccess: false,
          tokenVersion: row.userVersion,
        },
        data: { passwordHash, isActive: true, tokenVersion: { increment: 1 } },
      });
      if (user.count !== 1) throw invalid();
      await tx.tenantMembership.update({
        where: { id: row.membershipId },
        data: { tokenVersion: { increment: 1 } },
      });
      await recordActivation(tx, row);
      return {
        activated: true,
        email: row.membership.user.email,
        turfName: row.membership.tenant.name,
      };
    });
  }
}

async function recordActivation(
  tx: Prisma.TransactionClient,
  row: { id: string; userId: string; tenantId: string },
) {
  await tx.platformAuditEvent.create({
    data: {
      requestId: randomUUID(),
      action: 'owner_activated',
      actorId: row.userId,
      tenantId: row.tenantId,
      targetId: row.userId,
      inputHash: invitationHash(row.id),
      details: { invitationId: row.id },
    },
  });
}
