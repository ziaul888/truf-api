import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { trackJob } from '../common/job-runs.js';
import { env } from '../config/env.js';
import { SystemStateService } from '../settings/system-state.service.js';
import { SlotGeneratorService } from './slot-generator.service.js';

const HOUR_MS = 3_600_000;
/** Set once the closed-day cleanup for the Fri–Sat weekend has run, so it never runs twice. */
const WEEKEND_CLEANUP_KEY = 'weekend_fri_sat_cleanup';

/**
 * Keeps slots created up to the booking window: once at startup, then every hour (cheap — it
 * only inserts what's missing). Respects the `autoGenerate` setting. Off under tests.
 */
@Injectable()
export class SlotAutoGenerateJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SlotAutoGenerateJob.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly generator: SlotGeneratorService,
    private readonly state: SystemStateService,
  ) {}

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
    await this.retireClosedDaysOnce();
    try {
      const generated = await trackJob('slotGeneration', () => this.generator.fillWindow());
      if (generated > 0) this.logger.log(`Generated ${generated} slots`);
    } catch (err) {
      this.logger.error('Slot auto-generation failed', err instanceof Error ? err.stack : String(err));
    }
  }

  /** A failure is logged and retried on the next run; it never stops slot generation. */
  private async retireClosedDaysOnce() {
    try {
      if (await this.state.get<object | null>(WEEKEND_CLEANUP_KEY, null)) return;
      const { removed, blocked } = await this.generator.retireClosedDays();
      await this.state.set(WEEKEND_CLEANUP_KEY, { removed, blocked, ranAt: new Date().toISOString() });
      this.logger.log(`Closed-day cleanup: ${removed} free slots removed, ${blocked} blocked`);
    } catch (err) {
      this.logger.error('Closed-day cleanup failed', err instanceof Error ? err.stack : String(err));
    }
  }
}
