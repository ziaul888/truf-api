import { Controller, Get, UseGuards } from '@nestjs/common';
import { OwnerGuard, CurrentOwner } from './owner.guard.js';
import type { OwnerContext } from './owner-session.js';
import { OwnerBillingService } from './owner-billing.service.js';
@Controller('owner')
@UseGuards(OwnerGuard)
export class OwnerBillingController {
  constructor(private readonly billing: OwnerBillingService) {}
  @Get('billing') billingAccount(@CurrentOwner() owner: OwnerContext) {
    return this.billing.read(owner.session);
  }
}
