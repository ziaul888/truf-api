import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module.js';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module.js';
import { GroundsModule } from '../grounds/grounds.module.js';
import { OwnerModule } from '../owner/owner.module.js';
import { SlotsModule } from '../slots/slots.module.js';
import { TenantPortalController } from './tenant-portal.controller.js';
import { TenantCheckoutController } from './tenant-checkout.controller.js';
import { TenantCustomerController } from './tenant-customer.controller.js';
import { TenantPortalService } from './tenant-portal.service.js';

@Module({
  imports: [OwnerModule, GroundsModule, SlotsModule, BookingsModule, CustomerAuthModule],
  controllers: [TenantPortalController, TenantCheckoutController, TenantCustomerController],
  providers: [TenantPortalService],
})
export class TenantPortalModule {}
