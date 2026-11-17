import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { configureApp } from '../src/app.setup.js';
import { AuthService } from '../src/auth/auth.service.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { TenantsModule } from '../src/tenants/tenants.module.js';
import { ProofDatabase } from './tenant-isolation/proof-database.js';
import { ProofController } from './tenant-isolation/proof.controller.js';
import { password, seedProof } from './tenant-isolation/proof-fixtures.js';
import { ProofOperations } from './tenant-isolation/proof-operations.js';
import type { ProofState } from './tenant-isolation/proof-state.js';
import { authorizationCases } from './tenant-isolation/authorization-cases.js';
import { isolationCases } from './tenant-isolation/isolation-cases.js';
import { tenantAccountCases } from './tenant-isolation/tenant-account-cases.js';
import { singleTurfAccountCases } from './tenant-isolation/single-turf-account-cases.js';
import { transactionCases } from './tenant-isolation/transaction-cases.js';

describe('Tenant foundation isolation proof', () => {
  let db: ProofDatabase;
  let app: INestApplication<Server> | undefined;
  let state: ProofState;

  beforeAll(async () => {
    db = new ProofDatabase();
    await db.setup();
    const fixtures = await seedProof(db);
    const operations = new ProofOperations(db);
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, TenantsModule],
      controllers: [ProofController],
      providers: [{ provide: ProofOperations, useValue: operations }],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<Server>>();
    configureApp(app);
    await app.init();
    const auth = app.get(AuthService);
    const cookie = async (email: string) =>
      `admin_token=${(await auth.login({ email, password })).token}`;
    state = {
      db,
      app,
      fixtures,
      operations,
      cookies: {
        a: await cookie(fixtures.a.email),
        b: await cookie(fixtures.b.email),
        manager: await cookie(fixtures.manager.email),
        outsider: await cookie(fixtures.outsider.email),
      },
    };
  }, 30_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.dispose();
    }
  });

  authorizationCases(() => state);
  isolationCases(() => state);
  transactionCases(() => state);
  tenantAccountCases(() => state);
  singleTurfAccountCases(() => state);
});
