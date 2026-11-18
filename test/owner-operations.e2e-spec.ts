import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/app.setup.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { hashPassword } from '../src/auth/password.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { addDays, venueNow } from '../src/slots/venue-time.js';
import { requireProofDatabase } from './tenant-isolation/test-database-safety.js';

const password = 'tenant-operations-e2e-password';
const venue = {
  name: 'Independent Turf',
  tagline: '',
  email: 'info@example.test',
  supportEmail: null,
  phone: '01700000000',
  address: 'Dhaka, Bangladesh',
  openHours: '08:00–10:00',
  mapUrl: '',
  websiteUrl: '',
};
const ground = {
  name: 'Main Pitch',
  sport: 'football',
  hourlyPrice: 80_000,
  openingHour: 8,
  closingHour: 10,
};

describe('Turf owner setup and operations', () => {
  let app: INestApplication<Server>;
  let db: PrismaService;
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  let cookieA: string;
  let cookieB: string;
  const client = () => request(app.getHttpServer());
  const path = (suffix: string) => '/api/v1/owner/admin' + suffix;
  const get = (suffix: string, cookie: string) =>
    client().get(path(suffix)).set('Cookie', cookie);
  const put = (suffix: string, cookie: string, data: object) =>
    client().put(path(suffix)).set('Cookie', cookie).send(data);
  const post = (suffix: string, cookie: string, data: object) =>
    client().post(path(suffix)).set('Cookie', cookie).send(data);

  async function signInOwner() {
    const tag = randomUUID();
    const tenant = await db.tenant.create({
      data: { slug: tag, name: 'New Turf' },
    });
    tenantIds.push(tenant.id);
    const email = `owner-${tag}@example.test`;
    const user = await db.user.create({
      data: {
        email,
        name: 'Owner',
        passwordHash: await hashPassword(password),
        legacyStaffAccess: false,
      },
    });
    userIds.push(user.id);
    await db.tenantMembership.create({
      data: { tenantId: tenant.id, userId: user.id, role: 'owner' },
    });
    const login = await client()
      .post('/api/v1/admin/auth/login')
      .send({ email, password })
      .expect(200);
    expect(login.body.data.tenant.setupComplete).toBe(false);
    const cookies = login.headers['set-cookie'] as unknown as string[];
    return cookies
      .find((value) => value.startsWith('owner_token='))!
      .split(';')[0]!;
  }

  beforeAll(async () => {
    requireProofDatabase();
    const module = await Test.createTestingModule({
      imports: [PrismaModule, AuthModule],
    }).compile();
    app = configureApp(
      module.createNestApplication<INestApplication<Server>>(),
    );
    await app.init();
    db = app.get(PrismaService);
    [cookieA, cookieB] = await Promise.all([signInOwner(), signInOwner()]);
  });

  afterAll(async () => {
    try {
      if (!db) return;
      const where = { tenantId: { in: tenantIds } };
      await db.tenantSlot.deleteMany({ where });
      await db.tenantGround.deleteMany({ where });
      await db.tenantSetup.deleteMany({ where });
      await db.tenantMembership.deleteMany({ where });
      await db.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await app?.close();
    }
  });

  it('unlocks grounds and slots only after saving a complete venue profile', async () => {
    await client().get(path('/settings/venue')).expect(401);
    await get('/settings/venue', cookieA).expect(200);
    await get('/grounds', cookieA).expect(403);
    await post('/grounds', cookieA, ground).expect(403);
    await put('/settings/venue', cookieA, { name: venue.name }).expect(400);
    await put('/settings/venue', cookieA, venue).expect(200);
    const me = await client()
      .get('/api/v1/owner/auth/me')
      .set('Cookie', cookieA)
      .expect(200);
    expect(me.body.data.tenant).toMatchObject({
      name: venue.name,
      setupComplete: true,
    });
    const list = await get('/grounds', cookieA).expect(200);
    expect(list.body.data.data).toEqual([]);
    await get('/grounds', cookieB).expect(403);
  });

  it('isolates ground and slot writes, previews without saving, and avoids duplicates', async () => {
    await put('/settings/venue', cookieA, venue).expect(200);
    await put('/settings/venue', cookieB, {
      ...venue,
      name: 'Another Turf',
    }).expect(200);
    const created = await post('/grounds', cookieA, ground).expect(201);
    const { id: groundId } = created.body.data as { id: string };
    await get(`/grounds/${groundId}`, cookieB).expect(404);
    await client()
      .patch(path(`/grounds/${groundId}`))
      .set('Cookie', cookieB)
      .send({ name: 'Foreign update' })
      .expect(404);

    const date = addDays(venueNow(new Date(), 'Asia/Dhaka').date, 1);
    const input = { groundId, fromDate: date, toDate: date };
    await post('/slots/generate', cookieB, input).expect(404);
    const preview = await post('/slots/generate', cookieA, {
      ...input,
      dryRun: true,
    }).expect(201);
    expect(preview.body.data.generated).toBe(2);
    const before = await get(`/slots?date=${date}`, cookieA).expect(200);
    expect(before.body.data.data).toEqual([]);

    const generated = await post('/slots/generate', cookieA, input).expect(201);
    expect(generated.body.data.generated).toBe(2);
    const repeat = await post('/slots/generate', cookieA, input).expect(201);
    expect(repeat.body.data.generated).toBe(0);
    const own = await get(`/slots?date=${date}`, cookieA).expect(200);
    expect(own.body.data.data).toHaveLength(2);
    expect(own.body.data.data[0]).toMatchObject({
      groundId,
      price: 80_000,
      status: 'available',
    });
    const other = await get(`/slots?date=${date}`, cookieB).expect(200);
    expect(other.body.data.data).toEqual([]);
    const today = await get('/dashboard/today', cookieA).expect(200);
    expect(today.body.data.grounds).toMatchObject([{ groundId }]);
    const stats = await get('/dashboard/stats', cookieB).expect(200);
    expect(stats.body.data.activeGrounds).toBe(0);

    await client()
      .patch(path(`/grounds/${groundId}`))
      .set('Cookie', cookieA)
      .send({ hourlyPrice: 90_000 })
      .expect(200);
    const repriced = await get(`/slots?date=${date}`, cookieA).expect(200);
    expect(
      repriced.body.data.data.map((slot: { price: number }) => slot.price),
    ).toEqual([90_000, 90_000]);
  });
});
