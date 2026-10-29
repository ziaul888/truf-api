import { Injectable, SetMetadata, createParamDecorator, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../common/app-error.js';
import type { UserRole } from '../generated/prisma/client.js';
import { AUTH_COOKIE } from './auth-cookie.js';
import { AuthService } from './auth.service.js';
import type { AuthedRequest, AuthUser } from './auth.types.js';

const ROLES_KEY = 'roles';

/** Restricts a route or controller to the given roles. Use together with `AuthGuard`. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** The signed-in user, set by `AuthGuard`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined =>
    ctx.switchToHttp().getRequest<AuthedRequest>().user,
);

/**
 * Requires a valid `admin_token` cookie (401 otherwise) and, when `@Roles(...)` is set,
 * one of those roles (403 otherwise). Usage: `@UseGuards(AuthGuard)` on admin controllers.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const user = await this.auth.authenticate(req.cookies?.[AUTH_COOKIE]);
    req.user = user;

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (roles && !roles.includes(user.role)) {
      throw new AppError('You do not have permission to do that', 403, 'FORBIDDEN');
    }
    return true;
  }
}
