import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { env } from '../config/env.js';
import { SlotGeneratorService } from './slot-generator.service.js';

const HOUR_MS = 3_600_000;

/**
 * Keeps slots created up to the booking window: once at startup, then every hour (cheap — it
 * only inserts what's missing). Respects the `autoGenerate` setting. Off under tests.
 */
@Injectable()
export class SlotAutoGenerateJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SlotAutoGenerateJob.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly generator: SlotGeneratorService) {}

  onApplicationBootstrap() {
    if (env.NODE_ENV === 'test') return;
    void this.run();
    this.timer = setInterval(() => void this.run(), HOUR_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private async run() {
    try {
      const generated = await this.generator.fillWindow();
      if (generated > 0) this.logger.log(`Generated ${generated} slots`);
    } catch (err) {
      this.logger.error('Slot auto-generation failed', err instanceof Error ? err.stack : String(err));
    }
  }
}
