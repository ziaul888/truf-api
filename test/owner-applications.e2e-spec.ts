import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/app.setup.js';
import { hashPassword } from '../src/auth/password.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { OwnerApplicationsModule } from '../src/owner-applications/owner-applications.module.js';
import { PlatformAuthService } from '../src/platform/platform-auth.service.js';
import { PlatformModule } from '../src/platform/platform.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { requireProofDatabase } from './tenant-isolation/test-database-safety.js';

const admin = {
  email: 'platform@owner-application-e2e.test',
  password: 'platform-owner-application-password',
};
const ownerPassword = 'owner-application-password-123';
let sequence = 0;
let planId = '';
const application = () => {
  const n = ++sequence;
  return {
    requestId: randomUUID(),
    name: `Application E2E Turf ${n}`,
    slug: `owner-application-e2e-${n}`,
    ownerName: `Applicant ${n}`,
    ownerEmail: `applicant-${n}@owner-application-e2e.test`,
    password: ownerPassword,
    timezone: 'Asia/Dhaka',
    currency: 'bdt',
    planId,
    interval: 'monthly' as const,
  };
};

async function cleanup(db: PrismaService) {
  const tenant = { slug: { startsWith: 'owner-application-e2e-' } };
  const user = { email: { endsWith: '@owner-application-e2e.test' } };
  await db.platformAuditEvent.deleteMany({
    where: { OR: [{ tenant }, { actor: user }] },
  });
  await db.ownerApplication.deleteMany({ where: { ownerEmail: user.email } });
  await db.platformReceipt.deleteMany({ where: { invoice: { tenant } } });
  await db.platformInvoice.deleteMany({ where: { tenant } });
  await db.platformSubscription.deleteMany({ where: { tenant } });
  await db.tenantMembership.deleteMany({ where: { tenant } });
  await db.tenant.deleteMany({ where: tenant });
  await db.platformGrant.deleteMany({ where: { user } });
  await db.user.deleteMany({ where: user });
  const plan = { code: { startsWith: 'owner-application-e2e-' } };
  await db.platformPlanVersion.deleteMany({ where: { plan } });
  await db.platformPlan.deleteMany({ where: plan });
}

describe('Owner applications and SaaS admin activation', () => {
  let app: INestApplication<Server>;
  let db: PrismaService;
  let platformCookie: string;

  beforeAll(async () => {
    requireProofDatabase();
    db = new PrismaService();
    await cleanup(db);
    const user = await db.user.create({
      data: {
        email: admin.email,
        name: 'Application Platform Admin',
        passwordHash: await hashPassword(admin.password),
        role: 'admin',
      },
    });
    await db.platformGrant.create({ data: { userId: user.id } });
    const plan = await db.platformPlan.create({
      data: {
        code: 'owner-application-e2e-starter',
        name: 'Application Starter',
        description: 'Test plan for owner applications',
        versions: {
          create: {
            version: 1,
            currency: 'bdt',
            monthlyAmount: 150_000,
            yearlyAmount: 1_500_000,
          },
        },
      },
    });
    planId = plan.id;
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        AuthModule,
        OwnerApplicationsModule,
        PlatformModule,
      ],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<INestApplication<Server>>(),
    );
    await app.init();
    const session = await app.get(PlatformAuthService).login(admin);
    platformCookie = `platform_token=${session.token}`;
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(async () => {
    if (db) {
      try {
        await cleanup(db);
      } finally {
        await db.$disconnect();
      }
    }
  });

  const submit = (input: ReturnType<typeof application>) =>
    request(app.getHttpServer()).post('/api/v1/owner-applications').send(input);
  const platformPost = (path: string, body: object) =>
    request(app.getHttpServer())
      .post('/api/v1/platform' + path)
      .set('Cookie', platformCookie)
      .send(body);

  it('lists active plans publicly and requires a selected plan', async () => {
    const plans = await request(app.getHttpServer())
      .get('/api/v1/owner-applications/plans')
      .expect(200);
    expect(plans.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: planId,
          name: 'Application Starter',
          monthlyAmount: 150_000,
          yearlyAmount: 1_500_000,
        }),
      ]),
    );
    const input = application();
    const invalid = await submit({ ...input, planId: '' }).expect(400);
    expect(invalid.body.code).toBe('VALIDATION_FAILED');
  });

  it('keeps login disabled until platform activation, then issues an owner session', async () => {
    const input = application();
    const submitted = await submit(input).expect(201);
    expect(submitted.body.data).toMatchObject({
      turfName: input.name,
      ownerEmail: input.ownerEmail,
      status: 'pending',
      tenantId: null,
      plan: {
        id: planId,
        interval: 'monthly',
        selectedAmount: 150_000,
      },
    });
    expect(JSON.stringify(submitted.body)).not.toContain(ownerPassword);
    expect(submitted.body.data).not.toHaveProperty('passwordHash');

    await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ email: input.ownerEmail, password: ownerPassword })
      .expect(401);

    const denied = await request(app.getHttpServer())
      .post(`/api/v1/platform/applications/${submitted.body.data.id}/activate`)
      .send({ requestId: randomUUID() })
      .expect(401);
    expect(denied.body.code).toBe('PLATFORM_UNAUTHENTICATED');

    const list = await request(app.getHttpServer())
      .get('/api/v1/platform/applications?status=pending')
      .set('Cookie', platformCookie)
      .expect(200);
    expect(list.body.data.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: submitted.body.data.id }),
      ]),
    );

    const activated = await platformPost(
      `/applications/${submitted.body.data.id}/activate`,
      { requestId: randomUUID() },
    ).expect(201);
    expect(activated.body.data).toMatchObject({
      name: input.name,
      slug: input.slug,
      status: 'draft',
      owner: { email: input.ownerEmail, isActive: true },
    });

    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ email: input.ownerEmail, password: ownerPassword })
      .expect(200);
    expect(login.body.data).toMatchObject({
      email: input.ownerEmail,
      audience: 'owner',
      tenant: { status: 'draft' },
    });
    expect(login.headers['set-cookie']?.join(';')).toContain('owner_token=');
    expect(login.headers['set-cookie']?.join(';')).not.toContain(
      'admin_token=ey',
    );

    const subscription = await db.platformSubscription.findFirstOrThrow({
      where: { tenantId: activated.body.data.id },
    });
    expect(subscription).toMatchObject({
      planName: 'Application Starter',
      interval: 'monthly',
      amount: 150_000,
      status: 'pending',
    });
    const invoice = await db.platformInvoice.findFirstOrThrow({
      where: { subscriptionId: subscription.id },
    });
    expect(invoice).toMatchObject({ amount: 150_000, status: 'issued' });

    const stored = await db.ownerApplication.findUniqueOrThrow({
      where: { id: submitted.body.data.id },
    });
    expect(stored).toMatchObject({
      status: 'activated',
      passwordHash: null,
      tenantId: activated.body.data.id,
    });
    const audit = await db.platformAuditEvent.findFirstOrThrow({
      where: {
        action: 'application_activated',
        targetId: activated.body.data.id,
      },
    });
    expect(JSON.stringify(audit)).not.toContain(ownerPassword);
  });

  it('is idempotent for the same submission and rejects changed replays', async () => {
    const input = application();
    const first = await submit(input).expect(201);
    const replay = await submit(input).expect(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    await submit({ ...input, name: 'Changed turf name' }).expect(409);
  });

  it('rejects safely, clears the password hash and permits a new application', async () => {
    const input = application();
    const submitted = await submit(input).expect(201);
    await platformPost(`/applications/${submitted.body.data.id}/reject`, {
      requestId: randomUUID(),
    }).expect(201);
    const rejected = await db.ownerApplication.findUniqueOrThrow({
      where: { id: submitted.body.data.id },
    });
    expect(rejected).toMatchObject({ status: 'rejected', passwordHash: null });
    await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ email: input.ownerEmail, password: ownerPassword })
      .expect(401);
    await submit({ ...input, requestId: randomUUID() }).expect(201);
  });

  it('rejects hostile browser origins and weak passwords', async () => {
    const input = application();
    await submit(input).set('Origin', 'https://evil.example').expect(403);
    const weak = await submit({
      ...application(),
      password: 'short',
    }).expect(400);
    expect(weak.body.code).toBe('VALIDATION_FAILED');
  });
});
