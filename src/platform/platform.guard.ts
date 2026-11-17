import {
  Injectable,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { PlatformAuthService } from './platform-auth.service.js';
import {
  PLATFORM_COOKIE,
  type PlatformActor,
  type PlatformUser,
} from './platform-session.js';

type PlatformRequest = Request & {
  platformUser?: PlatformUser;
  platformActor?: PlatformActor;
};
export const CurrentPlatformUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<PlatformRequest>().platformUser,
);

export const CurrentPlatformActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<PlatformRequest>().platformActor,
);

@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(private readonly auth: PlatformAuthService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<PlatformRequest>();
    const session = await this.auth.authorize(req.cookies?.[PLATFORM_COOKIE]);
    req.platformUser = session.user;
    req.platformActor = session.actor;
    return true;
  }
}
