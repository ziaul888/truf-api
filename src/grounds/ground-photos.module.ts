import { Module } from '@nestjs/common';
import { GroundPhotosService } from './ground-photos.service.js';

@Module({
  providers: [GroundPhotosService],
  exports: [GroundPhotosService],
})
export class GroundPhotosModule {}
