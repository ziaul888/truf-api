import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureApp } from '../src/app.setup.js';
import { AuthService } from '../src/auth/auth.service.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PlatformModule } from '../src/platform/platform.module.js';
import { PlatformAuthService } from '../src/platform/platform-auth.service.js';
import { requireProofDatabase } from './tenant-isolation/test-database-safety.js';
import {
  cleanPlatformFixtures,
  seedPlatformFixtures,
} from './platform/platform-fixtures.js';
import {
  platformLogin,
  staffLogin,
  type PlatformFixtures,
  type PlatformState,
} from './platform/platform-state.js';
import { platformAuthCases } from './platform/platform-auth-cases.js';
import { platformTenantCases } from './platform/platform-tenant-cases.js';

describe('Platform administration', () => {
  let db: PrismaService,
    app: INestApplication<Server>,
    fixtures: PlatformFixtures,
    state: PlatformState;
  beforeAll(async () => {
    requireProofDatabase();
    db = new PrismaService();
    fixtures = await seedPlatformFixtures(db);
  });
  beforeEach(async () => {
    const ref = await Test.createTestingModule({
      imports: [PrismaModule, PlatformModule],
    }).compile();
    app = configureApp(ref.createNestApplication<INestApplication<Server>>());
    await app.init();
    const platform = await app.get(PlatformAuthService).login(platformLogin);
    const staff = await app.get(AuthService).login(staffLogin);
    state = {
      db,
      app,
      fixtures,
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
        await cleanPlatformFixtures(db);
      } finally {
        await db.$disconnect();
      }
    }
  });
  platformAuthCases(() => state);
  platformTenantCases(() => state);
});
