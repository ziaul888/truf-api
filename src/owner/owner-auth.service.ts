import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppError } from '../common/app-error.js';
import type { ChangePasswordInput } from '../auth/auth.schemas.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import type { User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  tenantOperator,
  ownerMembershipSelect,
  ownerUnauthenticated,
  requireOwner,
  requireTenantOperator,
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
      where: { userId: user.id, isActive: true },
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
      ...(row.role === 'owner' ? {} : { staff: true }),
    };
    const context = tenantOperator(row, session);
    return { user: context.user, token: await this.jwt.signAsync(session) };
  }
  async authorize(token?: string) {
    const session = await this.claims(token);
    if (!session) throw ownerUnauthenticated();
    return requireOwner(this.db, session);
  }
  async authorizeOperator(token?: string) {
    const session = await this.claims(token);
    if (!session) throw ownerUnauthenticated();
    return requireTenantOperator(this.db, session);
  }
  async changePassword(session: OwnerSession, input: ChangePasswordInput) {
    const user = await this.db.user.findUnique({
      where: { id: session.sub, tokenVersion: session.uv, isActive: true },
    });
    if (!user) throw ownerUnauthenticated();
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw new AppError('Current password is incorrect', 400, 'WRONG_PASSWORD');
    }
    const passwordHash = await hashPassword(input.newPassword);
    const updated = await this.db.$transaction(async (tx) => {
      await requireTenantOperator(tx, session);
      return tx.user.update({
        where: { id: session.sub, tokenVersion: session.uv, isActive: true },
        data: { passwordHash, tokenVersion: { increment: 1 } },
      });
    });
    return this.issueVerified(updated);
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
