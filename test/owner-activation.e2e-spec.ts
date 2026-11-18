import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PlatformAuthService } from '../src/platform/platform-auth.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { requireProofDatabase } from './tenant-isolation/test-database-safety.js';
import {
  cleanupOwnerFixtures,
  seedOwnerFixtures,
} from './owner-activation/fixtures.js';
import {
  platformCredentials,
  type OwnerState,
} from './owner-activation/state.js';
import { invitationCases } from './owner-activation/invitation-cases.js';
import { sessionCases } from './owner-activation/session-cases.js';
import { ownerBillingCases } from './owner-activation/billing-cases.js';
describe('Owner activation and account boundary', () => {
  let db: PrismaService,
    app: INestApplication<Server>,
    state: OwnerState,
    fixtures: { adminId: string; staffId: string };
  beforeAll(async () => {
    requireProofDatabase();
    db = new PrismaService();
    fixtures = await seedOwnerFixtures(db);
  });
  beforeEach(async () => {
    const ref = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(ref.createNestApplication<INestApplication<Server>>());
    await app.init();
    const platform = await app
        .get(PlatformAuthService)
        .login(platformCredentials),
      staff = await app.get(AuthService).login({
        ...platformCredentials,
        email: 'staff@owner-activation-e2e.test',
      });
    state = {
      db,
      app,
      ...fixtures,
      platformCookie: `platform_token=${platform.token}`,
      staffCookie: `admin_token=${staff.token}`,
    };
  });
  afterEach(async () => {
    await app?.close();
  });
  afterAll(async () => {
    if (db) {
      try {
        await cleanupOwnerFixtures(db);
      } finally {
        await db.$disconnect();
      }
    }
  });
  invitationCases(() => state);
  sessionCases(() => state);
  ownerBillingCases(() => state);
});
