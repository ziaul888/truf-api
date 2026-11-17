import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureApp } from '../src/app.setup.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { PlatformModule } from '../src/platform/platform.module.js';
import { PlatformAuthService } from '../src/platform/platform-auth.service.js';
import { requireProofDatabase } from './tenant-isolation/test-database-safety.js';
import {
  cleanupBilling,
  seedBilling,
} from './platform-billing/billing-fixtures.js';
import {
  credentials,
  type BillingState,
} from './platform-billing/billing-state.js';
import { onboardingCases } from './platform-billing/onboarding-cases.js';
import { subscriptionCases } from './platform-billing/subscription-cases.js';
import { receiptCases } from './platform-billing/receipt-cases.js';
import { renewalCases } from './platform-billing/renewal-cases.js';

describe('Platform onboarding and manual subscription billing', () => {
  let db: PrismaService, app: INestApplication<Server>, state: BillingState;
  let fixtures: { adminId: string; staffId: string };
  beforeAll(async () => {
    requireProofDatabase();
    db = new PrismaService();
    fixtures = await seedBilling(db);
  });
  beforeEach(async () => {
    const ref = await Test.createTestingModule({
      imports: [PrismaModule, PlatformModule],
    }).compile();
    app = configureApp(ref.createNestApplication<INestApplication<Server>>());
    await app.init();
    const platform = await app.get(PlatformAuthService).login(credentials);
    const staff = await app
      .get(AuthService)
      .login({ ...credentials, email: 'staff@billing-e2e.test' });
    state = {
      db,
      app,
      ...fixtures,
      cookie: `platform_token=${platform.token}`,
      staffCookie: `admin_token=${staff.token}`,
    };
  });
  afterEach(async () => {
    await app?.close();
  });
  afterAll(async () => {
    if (db) {
      try {
        await cleanupBilling(db);
      } finally {
        await db.$disconnect();
      }
    }
  });
  onboardingCases(() => state);
  subscriptionCases(() => state);
  receiptCases(() => state);
  renewalCases(() => state);
});
