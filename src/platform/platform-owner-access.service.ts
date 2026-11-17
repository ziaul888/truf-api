import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlatformCommands } from './platform-command.js';
import { withPlatformAvailability } from './platform-availability.js';
import type { PlatformActor } from './platform-session.js';
import { turfOwner, canInviteOwner } from './platform-owner-eligibility.js';
import { createOwnerInvitation } from './platform-owner-invitation-writes.js';
import {
  invitationHash,
  invitationToken,
} from '../owner/owner-invitation-token.js';
@Injectable()
export class PlatformOwnerAccessService {
  constructor(
    private readonly db: PrismaService,
    private readonly commands: PlatformCommands,
  ) {}
  state(tenantId: string) {
    return withPlatformAvailability(async () => {
      const owner = await turfOwner(this.db, tenantId);
      if (!owner)
        return {
          status: 'unassigned',
          canInvite: false,
          invitationExpiresAt: null,
        };
      const canInvite = await canInviteOwner(this.db, owner);
      const last = await this.db.ownerInvitation.findFirst({
        where: { membershipId: owner.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const invited =
        !!last &&
        !last.revokedAt &&
        !last.consumedAt &&
        last.expiresAt > new Date();
      const status = owner.user.isActive
        ? owner.user.legacyStaffAccess
          ? 'existing_account'
          : 'active'
        : canInvite
          ? invited
            ? 'invited'
            : 'pending'
          : 'inactive';
      return {
        status,
        canInvite,
        invitationExpiresAt: invited ? last.expiresAt.toISOString() : null,
      };
    });
  }
  async invite(actor: PlatformActor, tenantId: string, requestId: string) {
    const id = await this.commands.run(
      actor,
      { requestId, action: 'owner_invited', payload: { tenantId, requestId } },
      (tx) => createOwnerInvitation(tx, tenantId, actor.userId, requestId),
    );
    const row = await this.db.ownerInvitation.findUniqueOrThrow({
      where: { id },
    });
    const token = invitationToken(row.id, row.requestId);
    const available =
      !row.revokedAt &&
      !row.consumedAt &&
      row.expiresAt > new Date() &&
      invitationHash(token) === row.tokenHash;
    return {
      invitationId: row.id,
      token: available ? token : null,
      expiresAt: row.expiresAt.toISOString(),
    };
  }
}
