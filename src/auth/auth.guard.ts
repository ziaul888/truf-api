import {
  Injectable,
  SetMetadata,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../common/app-error.js';
import { OwnerAuthService } from '../owner/owner-auth.service.js';
import { OwnerOriginGuard } from '../owner/owner-origin.guard.js';
import { OWNER_COOKIE } from '../owner/owner-session.js';
import { requireVenue } from '../owner/owner-venue.js';
import type { UserRole } from '../generated/prisma/client.js';
import { AUTH_COOKIE } from './auth-cookie.js';
import { AuthService } from './auth.service.js';
import type { AuthedRequest, AuthUser } from './auth.types.js';

export const ROLES_KEY = 'roles';

/** Restricts a route or controller to the given roles. Use together with `AuthGuard`. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** The signed-in user, set by `AuthGuard`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined =>
    ctx.switchToHttp().getRequest<AuthedRequest>().user,
);

/**
 * Authenticates the session for the registered dashboard route and enforces
 * its `@Roles(...)` metadata.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
    private readonly owners: OwnerAuthService,
    private readonly ownerOrigin: OwnerOriginGuard,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const route = req.route as { path?: string } | undefined;
    const user = route?.path?.startsWith('/api/v1/owner/admin/')
      ? await this.authorizeTenant(ctx, req)
      : await this.auth.authenticate(req.cookies?.[AUTH_COOKIE]);
    req.user = user;

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (roles && !roles.includes(user.role)) {
      throw new AppError(
        'You do not have permission to do that',
        403,
        'FORBIDDEN',
      );
    }
    return true;
  }

  private async authorizeTenant(
    ctx: ExecutionContext,
    req: AuthedRequest,
  ): Promise<AuthUser> {
    if (req.method !== 'GET' && req.method !== 'HEAD')
      this.ownerOrigin.canActivate(ctx);
    const operator = await this.owners.authorizeOperator(
      req.cookies?.[OWNER_COOKIE],
    );
    requireVenue(operator);
    req.operator = operator;
    const { id, email, name, role } = operator.user;
    return { id, email, name, role: role === 'owner' ? 'admin' : role };
  }
}
