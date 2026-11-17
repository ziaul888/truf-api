import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ownerContext,
  ownerMembershipSelect,
  ownerUnauthenticated,
  requireOwner,
} from './owner-access.js';
import { OwnerSessionSchema, type OwnerSession } from './owner-session.js';
@Injectable()
export class OwnerAuthService {
  constructor(
    private readonly db: PrismaService,
    private readonly jwt: JwtService,
  ) {}
  async issueVerified(user: User) {
    if (!user.isActive || user.legacyStaffAccess) throw ownerUnauthenticated();
    const rows = await this.db.tenantMembership.findMany({
      where: { userId: user.id, role: 'owner', isActive: true },
      select: ownerMembershipSelect,
      take: 2,
    });
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      row.user.tokenVersion !== user.tokenVersion
    )
      throw ownerUnauthenticated();
    const session: OwnerSession = {
      sub: user.id,
      tid: row.tenantId,
      mid: row.id,
      uv: user.tokenVersion,
      mv: row.tokenVersion,
    };
    const context = ownerContext(row, session);
    return { user: context.user, token: await this.jwt.signAsync(session) };
  }
  async authorize(token?: string) {
    const session = await this.claims(token);
    if (!session) throw ownerUnauthenticated();
    return requireOwner(this.db, session);
  }
  async logout(token?: string) {
    const session = await this.claims(token);
    if (!session) return;
    await this.db.tenantMembership.updateMany({
      where: {
        id: session.mid,
        userId: session.sub,
        tenantId: session.tid,
        tokenVersion: session.mv,
        user: { tokenVersion: session.uv },
      },
      data: { tokenVersion: { increment: 1 } },
    });
  }
  private async claims(token?: string) {
    if (!token) return null;
    try {
      const parsed = OwnerSessionSchema.safeParse(
        await this.jwt.verifyAsync(token),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
