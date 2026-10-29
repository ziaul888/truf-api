import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminCustomersController } from './admin-customers.controller.js';
import { CustomersService } from './customers.service.js';

@Module({
  imports: [AuthModule],
  controllers: [AdminCustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
