import { Injectable, createParamDecorator, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { CUSTOMER_COOKIE } from './customer-cookie.js';
import { CustomerAuthService } from './customer-auth.service.js';
import type { CustomerRequest, CustomerSession } from './customer-auth.types.js';

/** The signed-in customer, set by `CustomerAuthGuard`. */
export const CurrentCustomer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CustomerSession | undefined =>
    ctx.switchToHttp().getRequest<CustomerRequest>().customer,
);

/** Requires a valid `customer_token` cookie (401 otherwise). */
@Injectable()
export class CustomerAuthGuard implements CanActivate {
  constructor(private readonly auth: CustomerAuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<CustomerRequest>();
    req.customer = await this.auth.authenticate(req.cookies?.[CUSTOMER_COOKIE]);
    return true;
  }
}
