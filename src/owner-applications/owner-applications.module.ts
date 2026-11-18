import { Module } from '@nestjs/common';
import { OwnerModule } from '../owner/owner.module.js';
import { OwnerApplicationsController } from './owner-applications.controller.js';
import { OwnerApplicationsService } from './owner-applications.service.js';

@Module({
  imports: [OwnerModule],
  controllers: [OwnerApplicationsController],
  providers: [OwnerApplicationsService],
})
export class OwnerApplicationsModule {}
