import {
  createParamDecorator,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { assertRoutePlanFeature } from '../platform/platform-plan-features.js';
import { OwnerAuthService } from './owner-auth.service.js';
import { OWNER_COOKIE, type OwnerRequest } from './owner-session.js';

@Injectable()
export class TenantOperatorGuard implements CanActivate {
  constructor(
    private readonly auth: OwnerAuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<OwnerRequest>();
    req.operator = await this.auth.authorizeOperator(
      req.cookies?.[OWNER_COOKIE],
    );
    assertRoutePlanFeature(
      this.reflector,
      ctx,
      req.operator.user.tenant.features,
    );
    return true;
  }
}

export const CurrentOperator = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<OwnerRequest>().operator,
);
