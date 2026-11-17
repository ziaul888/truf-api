import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../auth/auth.service.js';
import type { LoginInput } from '../auth/auth.schemas.js';
import { AppError } from '../common/app-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { withPlatformAvailability } from './platform-availability.js';
import {
  PlatformSessionSchema,
  type PlatformUser,
  type PlatformActor,
} from './platform-session.js';

const denied = () =>
  new AppError(
    'Your account does not have platform administrator access',
    403,
    'PLATFORM_ACCESS_DENIED',
  );
const unauthenticated = () =>
  new AppError(
    'Please sign in to the platform',
    401,
    'PLATFORM_UNAUTHENTICATED',
  );

@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly auth: AuthService,
    private readonly db: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(input: LoginInput) {
    const user = await this.auth.verifyCredentials(input);
    const grant = await this.grant(user.id);
    if (!grant?.isActive || !grant.user.isActive) throw denied();
    if (grant.user.tokenVersion !== user.tokenVersion) throw unauthenticated();
    const token = await this.jwt.signAsync({
      sub: user.id,
      gid: grant.id,
      ver: grant.tokenVersion,
      uv: user.tokenVersion,
    });
    return { user: this.dto(grant.user), token };
  }

  async authenticate(token: string | undefined): Promise<PlatformUser> {
    return (await this.authorize(token)).user;
  }

  async authorize(
    token: string | undefined,
  ): Promise<{ user: PlatformUser; actor: PlatformActor }> {
    const claims = await this.claims(token);
    if (!claims) throw unauthenticated();
    const grant = await this.grant(claims.sub);
    if (!grant?.isActive || !grant.user.isActive) throw denied();
    if (
      grant.id !== claims.gid ||
      grant.tokenVersion !== claims.ver ||
      grant.user.tokenVersion !== claims.uv
    )
      throw unauthenticated();
    return {
      user: this.dto(grant.user),
      actor: Object.freeze({
        userId: grant.user.id,
        grantId: grant.id,
        grantVersion: grant.tokenVersion,
        userVersion: grant.user.tokenVersion,
      }),
    };
  }

  async logout(token: string | undefined) {
    const claims = await this.claims(token);
    if (claims)
      await withPlatformAvailability(() =>
        this.db.platformGrant.updateMany({
          where: {
            id: claims.gid,
            userId: claims.sub,
            tokenVersion: claims.ver,
          },
          data: { tokenVersion: { increment: 1 } },
        }),
      );
  }

  private grant(userId: string) {
    return withPlatformAvailability(() =>
      this.db.platformGrant.findUnique({
        where: { userId },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              isActive: true,
              tokenVersion: true,
            },
          },
        },
      }),
    );
  }

  private async claims(token: string | undefined) {
    if (!token) return null;
    try {
      const parsed = PlatformSessionSchema.safeParse(
        await this.jwt.verifyAsync(token),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private dto(user: { id: string; name: string; email: string }): PlatformUser {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: 'platform_admin',
    };
  }
}
