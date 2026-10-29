import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/** Global, so feature modules can inject PrismaService without importing this module. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
