import {
  Injectable,
  SetMetadata,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { z } from 'zod';
import type { AuthedRequest } from '../auth/auth.types.js';
import { AppError } from '../common/app-error.js';
import type { TenantMembershipRole } from '../generated/prisma/client.js';
import type { TenantContext } from './tenant-access.js';
import { TenantAccessService } from './tenant-access.service.js';

const TENANT_ROLES = 'tenant:roles';
const tenantIdSchema = z.uuid();
type TenantRequest = AuthedRequest & { tenantContext?: TenantContext };

export const TenantRoles = (...roles: TenantMembershipRole[]) =>
  SetMetadata(TENANT_ROLES, roles);
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext | undefined =>
    ctx.switchToHttp().getRequest<TenantRequest>().tenantContext,
);

/** Must follow AuthGuard. Client tenant selectors and User.role never grant membership. */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly access: TenantAccessService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<TenantRequest>();
    if (!req.user) throw new AppError('Please sign in', 401, 'UNAUTHENTICATED');
    const parsed = tenantIdSchema.safeParse(req.params.tenantId);
    if (!parsed.success)
      throw new AppError(
        'Invalid business identifier',
        400,
        'VALIDATION_FAILED',
      );
    const roles =
      this.reflector.getAllAndOverride<TenantMembershipRole[]>(TENANT_ROLES, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? [];
    req.tenantContext = await this.access.require(
      req.user.id,
      parsed.data,
      roles,
    );
    return true;
  }
}
