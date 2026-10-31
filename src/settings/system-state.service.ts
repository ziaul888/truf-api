import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface WebhookState {
  lastEventAt: string | null;
  lastEventOk: boolean | null;
}

/** Small internal state kept across restarts: the last Stripe webhook, the last due digest. */
@Injectable()
export class SystemStateService {
  constructor(private readonly prisma: PrismaService) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    const row = await this.prisma.systemState.findUnique({ where: { key } });
    return row ? (row.data as T) : fallback;
  }

  async set(key: string, data: object): Promise<void> {
    const json = data as Prisma.InputJsonValue;
    await this.prisma.systemState.upsert({ where: { key }, create: { key, data: json }, update: { data: json } });
  }
}
