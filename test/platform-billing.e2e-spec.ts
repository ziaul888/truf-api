import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/app.setup.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { PlatformModule } from '../src/platform/platform.module.js';
import { PlatformAuthService } from '../src/platform/platform-auth.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { deleteImage } from '../src/settings/settings-images.js';
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
  it('authorizes, validates and persists the platform dashboard color', async () => {
    const where = { key: 'platform.dashboard.appearance' };
    const previous = await db.systemState.findUnique({ where });
    const client = request(app.getHttpServer());
    const appearance = '/api/v1/platform/appearance';
    try {
      await client.get(appearance).expect(401);
      await client
        .put(appearance)
        .set('Cookie', state.staffCookie)
        .send({ accentColor: '#2563EB' })
        .expect(401);
      await client
        .put(appearance)
        .set('Cookie', state.cookie)
        .send({ accentColor: 'blue' })
        .expect(400);
      await client
        .put(appearance)
        .set('Cookie', state.cookie)
        .send({ accentColor: '#7c3aed' })
        .expect(200);
      await client
        .get(appearance)
        .set('Cookie', state.cookie)
        .expect(200)
        .expect(({ body }) => {
          expect(body.data).toEqual({ accentColor: '#7C3AED' });
        });
      await client
        .put(appearance)
        .set('Cookie', state.cookie)
        .send({ accentColor: null })
        .expect(200)
        .expect(({ body }) => {
          expect(body.data).toEqual({ accentColor: null });
        });
    } finally {
      if (previous) {
        const data = previous.data;
        if (data && typeof data === 'object') {
          await db.systemState.update({ where, data: { data } });
        }
      } else {
        await db.systemState.deleteMany({ where });
      }
    }
  });

  it('shows platform branding publicly and restricts editing to platform admins', async () => {
    const where = { key: 'platform.dashboard.branding' };
    const previous = await db.systemState.findUnique({ where });
    const client = request(app.getHttpServer());
    const endpoint = '/api/v1/platform/branding';
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLfsAAAAASUVORK5CYII=',
      'base64',
    );
    let logo: string | undefined;
    try {
      await db.systemState.deleteMany({ where });
      const defaults = await client.get(endpoint).expect(200);
      expect(defaults.body.data.title).toBe('SaaS Admin');
      await client
        .put(endpoint)
        .set('Cookie', state.staffCookie)
        .send({ title: 'Denied', subtitle: '' })
        .expect(401);
      const invalid = await client
        .put(endpoint)
        .set('Cookie', state.cookie)
        .field('title', 'Demo Platform')
        .field('subtitle', '')
        .attach('logo', Buffer.from('<svg/>'), 'bad.png')
        .expect(400);
      expect(invalid.body.code).toBe('INVALID_IMAGE_TYPE');
      const result = await client
        .put(endpoint)
        .set('Cookie', state.cookie)
        .field('title', ' Demo Platform ')
        .field('subtitle', 'Demo subtitle')
        .attach('logo', png, 'logo.png')
        .expect(200);
      logo = result.body.data.logoUrl as string;
      expect(logo).toMatch(/^\/api\/v1\/uploads\/platform\/.*\.png$/);
      expect(result.body.data).toEqual({
        title: 'Demo Platform',
        subtitle: 'Demo subtitle',
        logoUrl: logo,
      });
      await client
        .get(logo)
        .expect(200)
        .expect('Content-Type', /image\/png/);
      const renamed = await client
        .put(endpoint)
        .set('Cookie', state.cookie)
        .field('title', 'New title')
        .field('subtitle', '')
        .expect(200);
      expect(renamed.body.data.logoUrl).toBe(logo);
      const reloaded = await client.get(endpoint).expect(200);
      expect(reloaded.body.data).toEqual({
        title: 'New title',
        subtitle: '',
        logoUrl: logo,
      });
      const removed = await client
        .put(endpoint)
        .set('Cookie', state.cookie)
        .field('title', 'New title')
        .field('subtitle', '')
        .field('logoAction', 'remove')
        .expect(200);
      expect(removed.body.data.logoUrl).toBeNull();
      await client.get(logo).expect(404);
    } finally {
      await deleteImage('platform', logo);
      if (previous) {
        const data = previous.data ?? Prisma.JsonNull;
        await db.systemState.upsert({
          where,
          create: { ...where, data },
          update: { data },
        });
      } else {
        await db.systemState.deleteMany({ where });
      }
    }
  });

  it('publishes desktop and mobile screenshots independently and lets platform admins restore defaults', async () => {
    const keys = [
      'platform.landing.screenshot.desktop',
      'platform.landing.screenshot.phone',
    ];
    const where = { key: { in: keys } };
    const previous = await db.systemState.findMany({ where });
    const client = request(app.getHttpServer());
    const endpoint = '/api/v1/platform/landing-screenshots';
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLfsAAAAASUVORK5CYII=',
      'base64',
    );
    const files: string[] = [];
    const upload = (slot: string, img = png) =>
      client
        .put(endpoint + '/' + slot)
        .set('Cookie', state.cookie)
        .attach('image', img, 'screenshot.png');
    try {
      await db.systemState.deleteMany({ where });
      const defaults = await client.get(endpoint).expect(200);
      expect(defaults.body.data).toEqual({ desktop: null, phone: null });
      await client
        .put(endpoint + '/desktop')
        .set('Cookie', state.staffCookie)
        .attach('image', png, 'screenshot.png')
        .expect(401);
      await client.delete(endpoint + '/phone').expect(401);
      await upload('other').expect(400);
      const invalid = await upload('desktop', Buffer.from('<svg/>')).expect(
        400,
      );
      expect(invalid.body.code).toBe('INVALID_IMAGE_TYPE');

      const desktop = (await upload('desktop').expect(200)).body.data
        .imageUrl as string;
      files.push(desktop);
      const phone = (await upload('phone').expect(200)).body.data
        .imageUrl as string;
      files.push(phone);
      expect(desktop).not.toEqual(phone);
      expect((await client.get(endpoint).expect(200)).body.data).toEqual({
        desktop,
        phone,
      });
      await client
        .get(desktop)
        .expect(200)
        .expect('Content-Type', /image\/png/);
      await client
        .get(phone)
        .expect(200)
        .expect('Content-Type', /image\/png/);

      const replaced = (await upload('desktop').expect(200)).body.data
        .imageUrl as string;
      files.push(replaced);
      await client.get(desktop).expect(404);
      const reset = await client
        .delete(endpoint + '/phone')
        .set('Cookie', state.cookie)
        .expect(200);
      expect(reset.body.data.imageUrl).toBeNull();
      expect((await client.get(endpoint).expect(200)).body.data).toEqual({
        desktop: replaced,
        phone: null,
      });
      await client.get(phone).expect(404);
    } finally {
      await Promise.all(files.map((file) => deleteImage('saas', file)));
      await db.systemState.deleteMany({ where });
      if (previous.length) {
        await db.systemState.createMany({
          data: previous.map(({ key, data }) => ({
            key,
            data: data ?? Prisma.JsonNull,
          })),
        });
      }
    }
  });

  onboardingCases(() => state);
  subscriptionCases(() => state);
  receiptCases(() => state);
  renewalCases(() => state);
});
