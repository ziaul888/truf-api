import { AsyncLocalStorage } from 'node:async_hooks';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { SlotSettings } from '../slots/slots.schemas.js';

export const dashboardData = new AsyncLocalStorage<{
  client: PrismaClient;
  tenantId: string;
  portalSlug?: string;
  timezone: string;
  currency: string;
  settings: SlotSettings;
}>();
