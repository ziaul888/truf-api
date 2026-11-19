import {
  applyDecorators,
  Controller,
  Injectable,
  UseGuards,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { from, lastValueFrom } from 'rxjs';
import { TenantDashboardDatabase } from '../owner/tenant-dashboard-database.service.js';
import { AuthGuard } from './auth.guard.js';
import type { AuthedRequest } from './auth.types.js';

@Injectable()
class DashboardDataInterceptor implements NestInterceptor {
  constructor(private readonly db: TenantDashboardDatabase) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const operator = context
      .switchToHttp()
      .getRequest<AuthedRequest>().operator;
    return operator
      ? from(
          this.db.run(operator.user.tenant, () => lastValueFrom(next.handle())),
        )
      : next.handle();
  }
}

export function DashboardController(path: string, ownerPath = path) {
  return applyDecorators(
    Controller([`admin/${path}`, `owner/admin/${ownerPath}`]),
    UseGuards(AuthGuard),
    UseInterceptors(DashboardDataInterceptor),
  );
}
