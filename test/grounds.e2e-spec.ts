import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { hashPassword } from './../src/auth/password.js';
import { rm } from 'node:fs/promises';
import { env } from './../src/config/env.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

const ADMIN_GROUNDS = '/api/v1/admin/grounds';
const PUBLIC_GROUNDS = '/api/v1/grounds';
const LOGIN = '/api/v1/admin/auth/login';
const DOMAIN = '@grounds.test';
const PREFIX = 'E2E Grounds';
const password = 'e2e-password-123';
const admin = { email: `admin${DOMAIN}`, password };
const manager = { email: `manager${DOMAIN}`, password };

describe('Grounds (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let activeId: string;
  let inactiveId: string;
  let hiddenId: string;

  const cleanup = async () => {
    const ours = { ground: { name: { startsWith: PREFIX } } };
    await prisma.slotEvent.deleteMany({ where: { ground: { name: { startsWith: PREFIX } } } });
    await prisma.slot.deleteMany({ where: ours });
    await prisma.ground.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await cleanup();
    const passwordHash = await hashPassword(password);
    await prisma.user.createMany({
      data: [
        { email: admin.email, name: 'Admin', role: 'admin', passwordHash },
        { email: manager.email, name: 'Manager', role: 'manager', passwordHash },
      ],
    });
    const base = { hourlyPrice: 1500, openingHour: 8, closingHour: 22, internalNotes: 'staff only' };
    const create = async (data: object) => (await prisma.ground.create({ data: { ...base, ...data } as never })).id;
    activeId = await create({ name: `${PREFIX} Active`, sport: 'football', format: '5x5', amenities: ['Parking'] });
    inactiveId = await create({ name: `${PREFIX} Closed`, sport: 'football', isActive: false });
    hiddenId = await create({ name: `${PREFIX} Hidden`, sport: 'cricket', showOnPortal: false });
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterEach(() => app.close());

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await rm(env.UPLOAD_DIR, { recursive: true, force: true });
  });

  async function signIn(creds: { email: string; password: string }) {
    const agent = request.agent(app.getHttpServer());
    await agent.post(LOGIN).send(creds).expect(200);
    return agent;
  }

  const publicGet = (path = '', query: object = {}) =>
    request(app.getHttpServer()).get(`${PUBLIC_GROUNDS}${path}`).query(query);

  describe('public', () => {
    it('lists only active grounds shown on the portal, without staff-only fields', async () => {
      const res = await publicGet('', { search: PREFIX }).expect(200);
      expect(res.body.data).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(res.body.data.data[0]).toEqual({
        id: activeId, name: `${PREFIX} Active`, description: null, address: null,
        hourlyPrice: 1500, openingHour: 8, closingHour: 22,
        sport: 'football', format: '5x5', surface: null, dimensions: null, capacity: null,
        amenities: ['Parking'], availableDays: 'everyday', customDays: [],
        peakPrice: null, peakRanges: [], slotDurationMinutes: 60, photos: [],
      });
    });

    it('filters by sport and format, and rejects unknown values', async () => {
      const football = await publicGet('', { search: PREFIX, sport: 'football', format: '5x5' }).expect(200);
      expect(football.body.data.total).toBe(1);
      const cricket = await publicGet('', { search: PREFIX, sport: 'cricket' }).expect(200);
      expect(cricket.body.data.total).toBe(0); // the cricket ground is hidden from the portal
      await publicGet('', { sport: 'golf' }).expect(400);
    });

    it('404s for inactive and hidden grounds', async () => {
      await publicGet(`/${activeId}`).expect(200);
      for (const id of [inactiveId, hiddenId]) {
        const res = await publicGet(`/${id}`).expect(404);
        expect(res.body.code).toBe('GROUND_NOT_FOUND');
      }
    });
  });

  describe('admin', () => {
    it('requires sign-in', async () => {
      await request(app.getHttpServer()).get(ADMIN_GROUNDS).expect(401);
    });

    it('managers can view everything (staff fields included) but not create or edit', async () => {
      const asManager = await signIn(manager);
      const list = await asManager.get(ADMIN_GROUNDS).query({ search: PREFIX, isActive: 'false' }).expect(200);
      expect(list.body.data.data.map((g: { id: string }) => g.id)).toEqual([inactiveId]);
      const hidden = await asManager.get(`${ADMIN_GROUNDS}/${hiddenId}`).expect(200);
      expect(hidden.body.data).toMatchObject({ showOnPortal: false, internalNotes: 'staff only' });

      const body = { name: `${PREFIX} X`, sport: 'other', hourlyPrice: 1, openingHour: 1, closingHour: 2 };
      await asManager.post(ADMIN_GROUNDS).send(body).expect(403);
      await asManager.patch(`${ADMIN_GROUNDS}/${activeId}`).send({ hourlyPrice: 1 }).expect(403);
    });

    it('admins create (201) and edit grounds with all details', async () => {
      const asAdmin = await signIn(admin);
      const created = await asAdmin.post(ADMIN_GROUNDS).send({
        name: `  ${PREFIX} New  `, sport: 'badminton', format: 'court', surface: 'indoor-court',
        dimensions: '13×6 m', capacity: 4, amenities: ['AC', 'Washroom'],
        availableDays: 'custom', customDays: ['fri', 'sat'],
        hourlyPrice: 2000, openingHour: 6, closingHour: 23, internalNotes: 'Key at front desk',
      }).expect(201);
      expect(created.body.data).toMatchObject({
        name: `${PREFIX} New`, sport: 'badminton', capacity: 4, customDays: ['fri', 'sat'],
        isActive: true, showOnPortal: true, internalNotes: 'Key at front desk',
      });

      const id = created.body.data.id;
      const public1 = await publicGet(`/${id}`).expect(200);
      expect(public1.body.data).not.toHaveProperty('internalNotes');

      const updated = await asAdmin.patch(`${ADMIN_GROUNDS}/${id}`).send({ availableDays: 'weekdays', showOnPortal: false }).expect(200);
      expect(updated.body.data).toMatchObject({ availableDays: 'weekdays', customDays: [], showOnPortal: false });
      await publicGet(`/${id}`).expect(404);
    });

    it('validates input', async () => {
      const asAdmin = await signIn(admin);
      const res = await asAdmin.post(ADMIN_GROUNDS)
        .send({ hourlyPrice: '1500', openingHour: 22, closingHour: 6, amenities: ['Pool'] }).expect(400);
      expect(res.body.details).toEqual(expect.arrayContaining([
        { field: 'name', message: 'This field is required' },
        { field: 'hourlyPrice', message: 'Must be a number' },
        { field: 'sport', message: 'This field is required' },
        expect.objectContaining({ field: 'amenities.0' }),
      ]));

      const hours = await asAdmin.patch(`${ADMIN_GROUNDS}/${activeId}`).send({ openingHour: 23 }).expect(400);
      expect(hours.body.code).toBe('INVALID_HOURS');
      const days = await asAdmin.patch(`${ADMIN_GROUNDS}/${activeId}`).send({ availableDays: 'custom' }).expect(400);
      expect(days.body.code).toBe('INVALID_DAYS');
      await asAdmin.get(`${ADMIN_GROUNDS}/not-a-uuid`).expect(400);
    });
  });

  describe('peak pricing and slot length', () => {
    it('saves peak pricing and 2-hour slots, and rejects bad ranges', async () => {
      const asAdmin = await signIn(admin);
      const ok = await asAdmin.patch(`${ADMIN_GROUNDS}/${activeId}`).send({
        peakPrice: 2500, peakRanges: [{ fromHour: 17, toHour: 22 }], slotDurationMinutes: 120,
      }).expect(200);
      expect(ok.body.data).toMatchObject({ peakPrice: 2500, peakRanges: [{ fromHour: 17, toHour: 22 }], slotDurationMinutes: 120 });

      const outside = await asAdmin.patch(`${ADMIN_GROUNDS}/${activeId}`).send({ peakRanges: [{ fromHour: 5, toHour: 9 }] }).expect(400);
      expect(outside.body.code).toBe('INVALID_PEAK_PRICING');
      const shrink = await asAdmin.patch(`${ADMIN_GROUNDS}/${activeId}`).send({ closingHour: 20 }).expect(400);
      expect(shrink.body.code).toBe('INVALID_PEAK_PRICING');
      await asAdmin.patch(`${ADMIN_GROUNDS}/${activeId}`).send({ slotDurationMinutes: 90 }).expect(400);

      await asAdmin.patch(`${ADMIN_GROUNDS}/${activeId}`).send({ peakPrice: null, peakRanges: [], slotDurationMinutes: 60 }).expect(200);
    });
  });

  describe('photos', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
    const photosUrl = () => `${ADMIN_GROUNDS}/${activeId}/photos`;

    it('uploads, serves, reorders and deletes photos', async () => {
      const asAdmin = await signIn(admin);
      const first = await asAdmin.post(photosUrl()).attach('photo', png, 'a.png').expect(201);
      const second = await asAdmin.post(photosUrl()).attach('photo', jpg, 'b.jpg').expect(201);
      const urls: string[] = second.body.data.photos;
      expect(first.body.data.photos).toHaveLength(1);
      expect(urls).toHaveLength(2);
      expect(urls[0]).toMatch(/^\/api\/v1\/uploads\/grounds\/.+\.png$/);

      const served = await request(app.getHttpServer()).get(urls[0]!).expect(200);
      expect(served.headers['content-type']).toBe('image/png');
      const pub = await publicGet(`/${activeId}`).expect(200);
      expect(pub.body.data.photos).toEqual(urls);

      const names = urls.map((u) => u.split('/').pop()!);
      const reordered = await asAdmin.put(photosUrl()).send({ photos: [names[1], names[0]] }).expect(200);
      expect(reordered.body.data.photos).toEqual([urls[1], urls[0]]);
      const badOrder = await asAdmin.put(photosUrl()).send({ photos: [names[0]] }).expect(400);
      expect(badOrder.body.code).toBe('INVALID_PHOTO_ORDER');

      for (const name of names) await asAdmin.delete(`${photosUrl()}/${name}`).expect(200);
      await request(app.getHttpServer()).get(urls[0]!).expect(404);
      const gone = await asAdmin.delete(`${photosUrl()}/${names[0]}`).expect(404);
      expect(gone.body.code).toBe('PHOTO_NOT_FOUND');
    });

    it('rejects non-images, oversized files, missing files, and managers', async () => {
      const asAdmin = await signIn(admin);
      const fake = await asAdmin.post(photosUrl()).attach('photo', Buffer.from('<svg/>'), 'x.png').expect(400);
      expect(fake.body.code).toBe('INVALID_PHOTO_TYPE');
      const big = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]);
      const large = await asAdmin.post(photosUrl()).attach('photo', big, 'big.png').expect(400);
      expect(large.body.code).toBe('PHOTO_TOO_LARGE');
      const none = await asAdmin.post(photosUrl()).expect(400);
      expect(none.body.code).toBe('PHOTO_REQUIRED');

      await (await signIn(manager)).post(photosUrl()).attach('photo', png, 'a.png').expect(403);
    });

    it('allows at most 5 photos', async () => {
      const asAdmin = await signIn(admin);
      for (let i = 0; i < 5; i++) await asAdmin.post(photosUrl()).attach('photo', png, 'p.png').expect(201);
      const sixth = await asAdmin.post(photosUrl()).attach('photo', png, 'p.png').expect(400);
      expect(sixth.body.code).toBe('TOO_MANY_PHOTOS');
    });
  });
});
