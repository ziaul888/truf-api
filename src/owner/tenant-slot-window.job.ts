import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { fillOwnerWindow } from './owner-slot-plan.js';
import { ownerTransaction } from './owner-transaction.js';
import { TenantDashboardDatabase } from './tenant-dashboard-database.service.js';

@Injectable()
export class TenantSlotWindowJob
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TenantSlotWindowJob.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: PrismaService,
    private readonly dashboard: TenantDashboardDatabase,
  ) {}

  onApplicationBootstrap() {
    if (env.NODE_ENV === 'test') return;
    void this.run();
    this.timer = setInterval(() => void this.run(), 3_600_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      await this.dashboard.forConfiguredTurfs(
        'slot generation',
        async (settings) => {
          if (!settings.autoGenerate) return;
          const grounds = await this.db.ground.findMany({
            where: { isActive: true },
          });
          for (const ground of grounds) {
            await ownerTransaction(this.db, async (tx) => {
              const current = await tx.ground.findUnique({
                where: { id: ground.id },
              });
              if (current) await fillOwnerWindow(tx, current, settings);
            });
          }
        },
      );
    } catch {
      this.logger.error('Could not load tenant grounds for slot generation');
    } finally {
      this.running = false;
    }
  }
}
