import { randomUUID } from 'node:crypto';
import { AppError } from '../common/app-error.js';
import type { PlatformTx } from './platform-command.js';
import {
  invitationHash,
  invitationToken,
} from '../owner/owner-invitation-token.js';
import { turfOwner, canInviteOwner } from './platform-owner-eligibility.js';
import type { OwnerMembership } from '../owner/owner-access.js';
export async function createOwnerInvitation(
  tx: PlatformTx,
  tenantId: string,
  actorId: string,
  requestId: string,
) {
  const owner = await turfOwner(tx, tenantId);
  if (!owner || !(await canInviteOwner(tx, owner)))
    throw new AppError(
      'This owner account cannot be activated with a new invitation. Existing active accounts keep their current sign-in.',
      409,
      'OWNER_INVITATION_UNAVAILABLE',
    );
  const id = randomUUID(),
    token = invitationToken(id, requestId);
  const member = await rotateInvitation(tx, owner);
  await tx.ownerInvitation.create({
    data: {
      id,
      requestId,
      membershipId: owner.id,
      tenantId,
      userId: owner.userId,
      issuedById: actorId,
      tokenHash: invitationHash(token),
      userVersion: owner.user.tokenVersion,
      membershipVersion: member.tokenVersion,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });
  return {
    targetId: id,
    tenantId,
    details: { ownerId: owner.userId, invitationId: id },
  };
}

async function rotateInvitation(tx: PlatformTx, owner: OwnerMembership) {
  await tx.ownerInvitation.updateMany({
    where: { membershipId: owner.id, consumedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return tx.tenantMembership.update({
    where: { id: owner.id },
    data: { tokenVersion: { increment: 1 } },
  });
}
