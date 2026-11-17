import {
  Injectable,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { OwnerAuthService } from './owner-auth.service.js';
import { OWNER_COOKIE, type OwnerRequest } from './owner-session.js';
@Injectable()
export class OwnerGuard implements CanActivate {
  constructor(private readonly auth: OwnerAuthService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<OwnerRequest>();
    req.owner = await this.auth.authorize(req.cookies?.[OWNER_COOKIE]);
    return true;
  }
}
export const CurrentOwner = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<OwnerRequest>().owner,
);
