import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppError } from '../common/app-error.js';
import type { User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ChangePasswordInput, LoginInput } from './auth.schemas.js';
import { toAuthUser, type AuthUser, type JwtPayload } from './auth.types.js';
import { hashPassword, verifyPassword } from './password.js';

// Checked when the email is unknown, so response time doesn't reveal which emails exist.
const dummyHash = hashPassword('timing-equaliser-not-a-real-password');

const invalidCredentials = () => new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
const unauthenticated = () => new AppError('Please sign in', 401, 'UNAUTHENTICATED');

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login({ email, password }: LoginInput): Promise<{ user: AuthUser; token: string }> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    const valid = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
    if (!user || !valid || !user.isActive) throw invalidCredentials();

    return { user: toAuthUser(user), token: await this.signToken(user) };
  }

  /**
   * Resolves the cookie token to an active user, or throws 401. The user is re-read on every
   * request, so deactivating someone or changing their role takes effect immediately.
   */
  async authenticate(token: string | undefined): Promise<AuthUser> {
    const payload = await this.verifyToken(token);
    if (!payload) throw unauthenticated();

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user?.isActive || user.tokenVersion !== payload.ver) throw unauthenticated();
    return toAuthUser(user);
  }

  /** Revokes every token the user holds (all devices). A missing or invalid token is a no-op. */
  async logout(token: string | undefined): Promise<void> {
    const payload = await this.verifyToken(token);
    if (!payload) return;

    await this.prisma.user.updateMany({
      where: { id: payload.sub, tokenVersion: payload.ver },
      data: { tokenVersion: { increment: 1 } },
    });
  }

  /** Changes the signed-in user's password, signs out their other sessions, returns a fresh token. */
  async changePassword(userId: string, input: ChangePasswordInput): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw unauthenticated();

    // 400, not 401: a 401 would make the frontend treat this as "signed out".
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw new AppError('Current password is incorrect', 400, 'WRONG_PASSWORD');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(input.newPassword), tokenVersion: { increment: 1 } },
    });
    return this.signToken(updated);
  }

  private signToken(user: User): Promise<string> {
    const payload: JwtPayload = { sub: user.id, role: user.role, ver: user.tokenVersion };
    return this.jwt.signAsync(payload);
  }

  private async verifyToken(token: string | undefined): Promise<JwtPayload | null> {
    if (!token) return null;
    return this.jwt.verifyAsync<JwtPayload>(token).catch(() => null);
  }
}
