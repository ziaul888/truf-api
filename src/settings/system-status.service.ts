import { readFileSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import { lastJobRun, type JobName, type JobRun } from '../common/job-runs.js';
import { env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SlotSettingsService } from '../slots/slot-settings.service.js';
import { SystemStateService, type WebhookState } from './system-state.service.js';

const STARTED_AT = new Date();
const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export interface PaymentsStatus {
  stripe: {
    configured: boolean;
    mode: 'test' | 'live' | null;
    webhook: { configured: boolean; lastEventAt: string | null; lastEventOk: boolean | null };
    currency: string;
  };
  methods: { card: boolean; cash: true; bankTransfer: true };
  portalCashEnabled: boolean;
}

const JOBS: JobName[] = ['slotGeneration', 'holdExpiry', 'completion', 'dueReminders', 'dueDigest'];

/**
 * Read-only health for the Payments and System pages. Says whether a key is set and which mode it
 * is in, never any part of a key, secret or connection string.
 */
@Injectable()
export class SystemStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: SystemStateService,
    private readonly slots: SlotSettingsService,
  ) {}

  async payments(): Promise<PaymentsStatus> {
    const key = env.STRIPE_SECRET_KEY;
    const [webhook, { portalCashEnabled }] = await Promise.all([
      this.state.get<WebhookState>('stripe_webhook', { lastEventAt: null, lastEventOk: null }),
      this.slots.get(),
    ]);
    return {
      stripe: {
        configured: Boolean(key),
        mode: key ? (key.startsWith('sk_live_') ? 'live' : 'test') : null,
        webhook: { configured: Boolean(env.STRIPE_WEBHOOK_SECRET), ...webhook },
        currency: env.CURRENCY,
      },
      methods: { card: Boolean(key), cash: true, bankTransfer: true },
      portalCashEnabled,
    };
  }

  /** Database size isn't reported: it needs raw SQL, which the codebase doesn't use. */
  async system() {
    const live = { deletedAt: null };
    const counts = await Promise.all([
      this.prisma.ground.count(), this.prisma.slot.count(), this.prisma.booking.count({ where: live }),
      this.prisma.customer.count({ where: live }), this.prisma.payment.count({ where: live }),
    ]).then(([grounds, slots, bookings, customers, payments]) => ({ grounds, slots, bookings, customers, payments }))
      .catch(() => null);
    return {
      version: VERSION,
      startedAt: STARTED_AT,
      database: { ok: counts !== null },
      counts,
      jobs: Object.fromEntries(JOBS.map((name) => [name, lastJobRun(name)])) as Record<JobName, JobRun | null>,
      integrations: {
        stripe: Boolean(env.STRIPE_SECRET_KEY),
        sendgrid: Boolean(env.SENDGRID_API_KEY),
        twilio: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID),
      },
    };
  }
}
