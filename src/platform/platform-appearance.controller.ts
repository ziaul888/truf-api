import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AppearanceSchema,
  storedAppearance,
  type Appearance,
} from '../settings/appearance.schemas.js';
import { requirePlatformActor } from './platform-command.js';
import { PlatformOriginGuard } from './platform-origin.guard.js';
import type { PlatformActor } from './platform-session.js';
import { CurrentPlatformActor, PlatformGuard } from './platform.guard.js';

const key = 'platform.dashboard.appearance';

@Controller('platform/appearance')
@UseGuards(PlatformGuard, PlatformOriginGuard)
export class PlatformAppearanceController {
  constructor(private readonly db: PrismaService) {}

  @Get()
  async get() {
    const row = await this.db.systemState.findUnique({ where: { key } });
    return storedAppearance(row?.data);
  }

  @Put()
  save(
    @CurrentPlatformActor() actor: PlatformActor,
    @Body(new ZodValidationPipe(AppearanceSchema)) data: Appearance,
  ) {
    return this.db.$transaction(async (tx) => {
      await requirePlatformActor(tx, actor);
      const row = await tx.systemState.upsert({
        where: { key },
        create: { key, data },
        update: { data },
      });
      return storedAppearance(row.data);
    });
  }
}
