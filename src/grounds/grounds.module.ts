import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SlotsModule } from '../slots/slots.module.js';
import { AdminGroundPhotosController } from './admin-ground-photos.controller.js';
import { AdminGroundsController } from './admin-grounds.controller.js';
import { GroundPhotosService } from './ground-photos.service.js';
import { GroundsController } from './grounds.controller.js';
import { GroundsService } from './grounds.service.js';

@Module({
  imports: [AuthModule, SlotsModule],
  controllers: [GroundsController, AdminGroundsController, AdminGroundPhotosController],
  providers: [GroundsService, GroundPhotosService],
  exports: [GroundsService],
})
export class GroundsModule {}
