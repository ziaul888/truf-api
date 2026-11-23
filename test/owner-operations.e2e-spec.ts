import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/app.setup.js';
import { AppModule } from '../src/app.module.js';
import { hashPassword } from '../src/auth/password.js';
import { env } from '../src/config/env.js';
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
  const planIds: string[] = [];
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

  async function signIn(email: string, secret = password) {
    const login = await client()
      .post('/api/v1/admin/auth/login')
      .send({ email, password: secret })
      .expect(200);
    const cookies = login.headers['set-cookie'] as unknown as string[];
    const cookie = cookies
      .find((value) => value.startsWith('owner_token='))!
      .split(';')[0]!;
    expect(cookies.join(';')).not.toContain('admin_token=ey');
    return { cookie, user: login.body.data };
  }

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
    const { cookie, user: signedIn } = await signIn(email);
    expect(signedIn.tenant.setupComplete).toBe(false);
    return cookie;
  }

  beforeAll(async () => {
    requireProofDatabase();
    const module = await Test.createTestingModule({
      imports: [AppModule],
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
      for (const id of tenantIds) {
        const suffix = id.replaceAll('-', '');
        if (!/^[0-9a-f]{32}$/.test(suffix))
          throw new Error('Invalid fixture ID');
        await db.$executeRawUnsafe(
          `DROP SCHEMA IF EXISTS "turf_${suffix}" CASCADE`,
        );
      }
      const where = { tenantId: { in: tenantIds } };
      await db.tenantSlot.deleteMany({ where });
      await db.tenantGround.deleteMany({ where });
      await db.tenantSetup.deleteMany({ where });
      await db.tenantMembership.deleteMany({ where });
      await db.platformSubscription.deleteMany({ where });
      const plans = { id: { in: planIds } };
      await db.platformPlanVersion.deleteMany({ where: { plan: plans } });
      await db.platformPlan.deleteMany({ where: plans });
      await db.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await app?.close();
    }
  });

  it('enforces the plan on dashboard modules, staff sessions and the public website', async () => {
    const ownerCookie = await signInOwner();
    const session = await get('/session', ownerCookie).expect(200);
    const { id: tenantId, slug } = session.body.data.tenant;
    await put('/settings/venue', ownerCookie, venue).expect(200);
    await put('/settings/website/portal', ownerCookie, {
      published: true,
    }).expect(200);
    const website = '/api/v1/turfs/' + slug + '/website';
    await client().get(website).expect(200);

    const email = `plan-staff-${randomUUID()}@example.test`;
    const created = await post('/users', ownerCookie, {
      email,
      name: 'Plan Staff',
      password,
      role: 'manager',
    }).expect(201);
    userIds.push(created.body.data.id);
    const staff = await signIn(email);
    const plan = await db.platformPlan.create({
      data: {
        code: 'test-features-' + randomUUID(),
        name: 'Core and refunds',
        versions: {
          create: {
            version: 1,
            monthlyAmount: 50_000,
            yearlyAmount: 500_000,
            features: ['refunds'],
          },
        },
      },
      include: { versions: true },
    });
    planIds.push(plan.id);
    await db.platformSubscription.create({
      data: {
        tenantId,
        planVersionId: plan.versions[0].id,
        planName: plan.name,
        interval: 'monthly',
        currency: 'bdt',
        amount: 50_000,
        anchorDate: new Date(),
        status: 'active',
      },
    });

    await get('/session', ownerCookie)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.tenant.features).toEqual(['refunds']);
      });
    await get('/bookings', ownerCookie).expect(200);
    await get('/grounds', ownerCookie).expect(200);
    await get('/bookings/refunds', ownerCookie).expect(200);
    await get('/session', staff.cookie).expect(401);
    for (const route of [
      '/users',
      '/settings/website',
      '/settings/website/portal',
      '/reports/summary',
      '/reports/export',
    ]) {
      await get(route, ownerCookie)
        .expect(403)
        .expect(({ body }) => {
          expect(body.code).toBe('PLAN_FEATURE_REQUIRED');
        });
    }
    await client().get(website).expect(404);
  });

  it('keeps dashboard appearance separate for each turf during and after setup', async () => {
    const ownerCookie = await signInOwner();
    const endpoint = '/settings/appearance';
    await client().get(path(endpoint)).expect(401);
    await get(endpoint, ownerCookie).expect(200).expect(({ body }) => {
      expect(body.data).toEqual({ accentColor: null });
    });
    await put(endpoint, ownerCookie, { accentColor: 'blue' }).expect(400);
    await put(endpoint, ownerCookie, { accentColor: '#2563eb' }).expect(200).expect(({ body }) => {
      expect(body.data).toEqual({ accentColor: '#2563EB' });
    });
    await put(endpoint, cookieB, { accentColor: '#7C3AED' }).expect(200);
    await put('/settings/venue', ownerCookie, venue).expect(200);
    await get(endpoint, ownerCookie).expect(200).expect(({ body }) => {
      expect(body.data).toEqual({ accentColor: '#2563EB' });
    });
    await put(endpoint, ownerCookie, { accentColor: null }).expect(200);
    await get(endpoint, cookieB).expect(200).expect(({ body }) => {
      expect(body.data).toEqual({ accentColor: '#7C3AED' });
    });
    await put(endpoint, cookieB, { accentColor: null }).expect(200);
  });

  it('unlocks grounds and slots only after saving a complete venue profile', async () => {
    await client().get(path('/settings/venue')).expect(401);
    await get('/settings/venue', cookieA).expect(200);
    await put('/settings/slots', cookieA, { advanceBookingDays: 14 }).expect(
      200,
    );
    await get('/grounds', cookieA).expect(403);
    await get('/bookings', cookieA).expect(403);
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

  it('opens the full dashboard and keeps bookings, customers, payments and slot activity inside the turf', async () => {
    const legacyOwner = await signInOwner();
    const tenantId = tenantIds.at(-1)!;
    const oldGround = await db.tenantGround.create({
      data: { ...ground, sport: 'football', tenantId },
    });
    const date = addDays(venueNow(new Date(), 'Asia/Dhaka').date, 3);
    const oldSlot = await db.tenantSlot.create({
      data: {
        tenantId,
        groundId: oldGround.id,
        date: new Date(date),
        startHour: 8,
        price: 80_000,
      },
    });
    await put('/settings/venue', legacyOwner, venue).expect(200);
    await put('/settings/venue', cookieB, venue).expect(200);
    await get('/bookings', legacyOwner)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.data).toEqual([]);
      });
    const form = {
      slotId: oldSlot.id,
      customer: { name: 'Isolated Team', phone: '01711223344' },
      payment: { type: 'full', method: 'bkash', reference: 'TURFBK001' },
    };
    await post('/bookings', cookieB, form).expect(404);
    await post('/bookings', legacyOwner, form)
      .set('Origin', 'https://other.example.test')
      .expect(403);
    const booking = await post('/bookings', legacyOwner, form).expect(201);
    const { id } = booking.body.data;
    await get(`/bookings/${id}`, legacyOwner).expect(200);
    await get(`/bookings/${id}`, cookieB).expect(404);
    await client()
      .get('/api/v1/admin/bookings')
      .set('Cookie', legacyOwner)
      .expect(401);
    await get('/customers', legacyOwner)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.data).toMatchObject([{ name: 'Isolated Team' }]);
      });
    await get('/customers', cookieB)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.data).toEqual([]);
      });
    await get(`/operations/slots/calendar?from=${date}&to=${date}`, legacyOwner)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.slots).toMatchObject([
          { id: oldSlot.id, status: 'booked', bookingId: id },
        ]);
      });
    await get('/operations/dashboard/stats', legacyOwner)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.totalRevenue).toBe(80_000);
      });
    await get(`/reports/summary?from=${date}&to=${date}`, legacyOwner)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.bookings).toBe(1);
      });
    await get(`/reports/summary?from=${date}&to=${date}`, cookieB)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.bookings).toBe(0);
      });
    await get('/reports/export?type=customers', legacyOwner)
      .expect(200)
      .expect(/Isolated Team/);
    await get('/reports/export?type=customers', cookieB)
      .expect(200)
      .expect(({ text }) => {
        expect(text).not.toContain('Isolated Team');
      });
    await post(`/bookings/${id}/cancel`, legacyOwner, {
      refund: true,
      notifyCustomer: false,
    }).expect(200);
    await get('/bookings/refunds', legacyOwner)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.data).toHaveLength(1);
      });
    await get('/bookings/refunds', cookieB)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.data).toEqual([]);
      });
    await post(`/operations/slots/${oldSlot.id}/block`, legacyOwner, {
      reason: 'maintenance',
    }).expect(200);
    await get('/slot-events', legacyOwner)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.data).toHaveLength(1);
      });
    await get('/slot-events', cookieB)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.data).toEqual([]);
      });
    await get('/closures', legacyOwner).expect(200);
    await get('/operations/dashboard/today', legacyOwner).expect(200);
    await get('/operations/dashboard/attention', legacyOwner).expect(200);
    await get('/booking-events', legacyOwner).expect(200);
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
    const calendar = `/slots/calendar?from=${date}&to=${date}`;
    await get(calendar, cookieA)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.totals).toEqual([{ date, groundId, totalSlots: 2 }]);
      });
    await get(calendar, cookieB)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toEqual({ slots: [], totals: [] });
      });
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

  it('saves settings for one turf and resets only the selected section', async () => {
    await put('/settings/venue', cookieA, venue).expect(200);
    const saved = await put('/settings/slots', cookieA, {
      advanceBookingDays: 7,
      bkashNumber: '01700000000',
    }).expect(200);
    expect(saved.body.data).toMatchObject({
      advanceBookingDays: 7,
      updatedBy: { name: 'Owner' },
    });
    const prefs = await get('/settings/payments/status', cookieA).expect(200);
    expect(prefs.body.data.methods.bkash).toBe(true);
    const other = await get('/settings/slots', cookieB).expect(200);
    expect(other.body.data).toMatchObject({
      advanceBookingDays: 30,
      bkashNumber: null,
    });

    await put('/settings/website', cookieA, {
      social: {
        facebook: 'https://example.test/turf',
        instagram: '',
        whatsapp: '',
      },
    }).expect(200);
    await put('/settings/notifications', cookieA, {
      customer: { slotBlocked: false },
    }).expect(200);
    const flags = await get('/settings/slots', cookieA).expect(200);
    expect(flags.body.data.notifyCustomerOnBlock).toBe(false);
    await post('/settings/reset', cookieA, {
      sections: ['notifications'],
    }).expect(200);
    const reset = await get('/settings/slots', cookieA).expect(200);
    expect(reset.body.data).toMatchObject({
      notifyCustomerOnBlock: true,
      advanceBookingDays: 7,
    });
    const website = await get('/settings/website', cookieA).expect(200);
    expect(website.body.data.social.facebook).toBe('https://example.test/turf');
  });

  it('isolates staff administration and revokes a session when access changes', async () => {
    await put('/settings/venue', cookieA, venue).expect(200);
    await put('/settings/venue', cookieB, venue).expect(200);
    const email = `manager-${randomUUID()}@example.test`;
    const created = await post('/users', cookieA, {
      email,
      name: 'Pitch Manager',
      password,
      role: 'manager',
    }).expect(201);
    const id = created.body.data.id as string;
    userIds.push(id);
    expect(created.body.data).not.toHaveProperty('passwordHash');
    await get(`/users/${id}`, cookieB).expect(404);
    await post(`/users/${id}/reset-password`, cookieB, { password }).expect(
      404,
    );
    const listed = await get('/users?search=Pitch', cookieA).expect(200);
    expect(listed.body.data.data).toMatchObject([{ id }]);

    const staff = await signIn(email);
    expect(staff.user).toMatchObject({
      role: 'manager',
      audience: 'tenant-staff',
    });
    await get('/grounds', staff.cookie).expect(200);
    await post('/grounds', staff.cookie, ground).expect(403);
    await put('/settings/slots', staff.cookie, {
      advanceBookingDays: 60,
    }).expect(403);
    await get('/users', staff.cookie).expect(403);
    await get('/settings/appearance', staff.cookie).expect(200);
    await put('/settings/appearance', staff.cookie, { accentColor: '#DA291C' }).expect(403);

    await client()
      .get('/api/v1/owner/auth/me')
      .set('Cookie', staff.cookie)
      .expect(401);
    await client()
      .get('/api/v1/admin/auth/me')
      .set('Cookie', staff.cookie)
      .expect(401);

    await client()
      .patch(path(`/users/${id}`))
      .set('Cookie', cookieA)
      .send({ role: 'admin' })
      .expect(200);
    await get('/session', staff.cookie).expect(401);
    const admin = await signIn(email);
    await post('/grounds', admin.cookie, ground).expect(201);
    await client()
      .patch(path(`/users/${id}`))
      .set('Cookie', cookieA)
      .send({ isActive: false })
      .expect(200);
    await get('/session', admin.cookie).expect(401);
    await client()
      .post('/api/v1/admin/auth/login')
      .send({ email, password })
      .expect(401);
  });

  it('auto-generates slots for a new ground using the turf’s saved window', async () => {
    await put('/settings/venue', cookieA, venue).expect(200);
    await put('/settings/slots', cookieA, {
      autoGenerate: true,
      advanceBookingDays: 1,
    }).expect(200);
    const result = await post('/grounds', cookieA, {
      ...ground,
      name: 'Automatic slots pitch',
    }).expect(201);
    const date = addDays(venueNow(new Date(), 'Asia/Dhaka').date, 1);
    const slots = await get(
      `/slots?groundId=${result.body.data.id}&date=${date}`,
      cookieA,
    ).expect(200);
    expect(slots.body.data.data).toHaveLength(2);
  });

  it('changes a turf password and replaces its session', async () => {
    const cookie = await signInOwner();
    const account = await get('/session', cookie).expect(200);
    const email = account.body.data.email as string;
    const newPassword = 'tenant-e2e-replacement-password';
    await post('/auth/change-password', cookie, {
      currentPassword: 'incorrect password',
      newPassword,
    }).expect(400);
    const changed = await post('/auth/change-password', cookie, {
      currentPassword: password,
      newPassword,
    }).expect(200);
    const refreshedCookie = (
      changed.headers['set-cookie'] as unknown as string[]
    )
      .find((value) => value.startsWith('owner_token='))!
      .split(';')[0]!;
    await get('/session', cookie).expect(401);
    await get('/session', refreshedCookie).expect(200);
    await signIn(email, newPassword);
  });

  it('publishes a turf portal with isolated grounds, customer sessions and checkout', async () => {
    const owner = await signInOwner();
    const other = await signInOwner();
    const own = (await get('/session', owner).expect(200)).body.data.tenant.slug as string;
    const foreign = (await get('/session', other).expect(200)).body.data.tenant.slug as string;
    const portal = (slug: string, suffix: string) => `/api/v1/turfs/${slug}${suffix}`;
    const show = '/settings/website/portal';
    await client().get(portal(own, '/website')).expect(404);
    await put(show, owner, { published: true }).expect(403);
    await put('/settings/venue', owner, venue).expect(200);
    await put('/settings/venue', other, { ...venue, name: 'Second Portal' }).expect(200);
    await put('/settings/slots', owner, {
      portalCashEnabled: true,
      portalCardEnabled: true,
      bkashNumber: '01712345678',
      portalBkashEnabled: true,
    }).expect(200);
    const website = await get('/settings/website', owner).expect(200);
    await put('/settings/website', owner, {
      hero: { ...website.body.data.hero, headline: 'Book the Public Pitch' },
    }).expect(200);
    const hidden = await post('/grounds', owner, ground).expect(201);
    const created = await post('/grounds', owner, {
      ...ground,
      name: 'Public Pitch',
      showOnPortal: true,
    }).expect(201);
    const id = created.body.data.id as string;
    const date = addDays(venueNow(new Date(), 'Asia/Dhaka').date, 2);
    await post('/slots/generate', owner, { groundId: id, fromDate: date, toDate: date }).expect(201);
    await put(show, owner, { published: true }).expect(200);
    await client().get('/api/v1/turfs/default').expect(200).expect(({ body }) => {
      expect(body.data).toEqual({ slug: own });
    });
    await put(show, other, { published: true }).expect(200);
    await client().get('/api/v1/turfs/default').expect(200).expect(({ body }) => {
      expect(body.data).toEqual({ slug: null });
    });

    await client().get(portal(own, '/website')).expect(200).expect(({ body }) => {
      expect(body.data.venue.name).toBe(venue.name);
      expect(body.data.hero.headline).toBe('Book the Public Pitch');
      expect(body.data.venue).not.toHaveProperty('supportEmail');
    });
    await client().get(portal(own, '/grounds')).expect(200).expect(({ body }) => {
      expect(body.data.data).toMatchObject([{ id, name: 'Public Pitch' }]);
      expect(body.data.total).toBe(1);
    });
    await client().get(portal(own, `/grounds/${hidden.body.data.id}`)).expect(404);
    await client().get(portal(foreign, `/grounds/${id}`)).expect(404);
    await client().get(portal(own, '/checkout/options')).expect(200).expect(({ body }) => {
      expect(body.data).toMatchObject({
        cashEnabled: true,
        cardEnabled: false,
        wallets: [{ method: 'bkash', number: '+8801712345678' }],
      });
    });
    await client().get(portal(own, `/grounds/${id}/slots?date=${date}`)).expect(200).expect(({ body }) => {
      expect(body.data).toMatchObject([{ available: true }, { available: true }]);
    });

    const phone = '01719998877';
    const form = {
      groundId: id,
      date,
      startHour: 8,
      customerName: 'Portal Customer',
      customerPhone: phone,
      paymentMethod: 'cash',
    };
    await client().post(portal(own, '/checkout')).send(form).expect(401);
    const verified = await client().post(portal(own, '/customer/auth/verify'))
      .send({ phone, code: env.TEST_OTP_CODE }).expect(200);
    const cookie = (verified.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    expect(verified.headers['set-cookie']?.[0]).toContain(`Path=/api/v1/turfs/${own}`);
    await client().get(portal(foreign, '/customer/auth/me')).set('Cookie', cookie).expect(401);
    await client().get('/api/v1/customer/auth/me').set('Cookie', cookie.replace('turf_customer_token=', 'customer_token=')).expect(401);
    await client().post(portal(own, '/customer/auth/profile')).set('Cookie', cookie)
      .send({ name: form.customerName, email: '' }).expect(200);
    const result = await client().post(portal(own, '/checkout')).set('Cookie', cookie).send(form).expect(201);
    const bookingId = result.body.data.bookingId as string;
    const confirmation = new URL(result.body.data.confirmationUrl);
    const bookingLink = `/bookings/${bookingId}${confirmation.search}`;
    expect(confirmation.pathname).toBe(`/turf/${own}/confirmation/${bookingId}`);
    await client().get(portal(foreign, bookingLink)).expect(404);
    await client().get(portal(own, bookingLink)).expect(200).expect(({ body }) => {
      expect(body.data).toMatchObject({ status: 'pending', payAtVenue: true, canPay: false });
    });
    await client().get(portal(own, '/customer/bookings')).set('Cookie', cookie).expect(200).expect(({ body }) => {
      expect(body.data.total).toBe(1);
    });
    await get(`/bookings/${bookingId}`, owner).expect(200);
    await get(`/bookings/${bookingId}`, other).expect(404);
    await put(show, owner, { published: false }).expect(200);
    await client().get(portal(own, '/website')).expect(404);
    await client().get(portal(own, '/grounds')).expect(404);
    await get(`/bookings/${bookingId}`, owner).expect(200);
  });
});
