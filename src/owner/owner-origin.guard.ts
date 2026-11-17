import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../common/app-error.js';
@Injectable()
export class OwnerOriginGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const origin = ctx.switchToHttp().getRequest<Request>().get('Origin');
    if (origin && !env.CORS_ORIGINS.includes(origin))
      throw new AppError(
        'This sign-in origin is not allowed',
        403,
        'OWNER_ORIGIN_DENIED',
      );
    return true;
  }
}
