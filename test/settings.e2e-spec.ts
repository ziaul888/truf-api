import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { hashPassword } from './../src/auth/password.js';
import { env } from './../src/config/env.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

const API = '/api/v1';
const S = `${API}/admin/settings`;
const DOMAIN = '@settings.test';
const password = 'e2e-password-123';
// This file owns the venue, website and notifications sections in the test database. It never
// changes slot settings, which other files read.
const SECTIONS = ['venue', 'website', 'notifications'];

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64)]);
const fileOf = (url: string) => resolve(env.UPLOAD_DIR, url.replace(`${API}/uploads/`, ''));

describe('Settings (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: ReturnType<typeof request.agent>;
  let manager: ReturnType<typeof request.agent>;

  const cleanup = async () => {
    await prisma.settingsSection.deleteMany({ where: { key: { in: SECTIONS } } });
    await prisma.settingsEvent.deleteMany({ where: { section: { in: SECTIONS } } });
    await prisma.emailLog.deleteMany({ where: { to: { endsWith: DOMAIN } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await cleanup();
    const passwordHash = await hashPassword(password);
    await prisma.user.createMany({
      data: [
        { email: `admin${DOMAIN}`, name: 'Settings Admin', role: 'admin', passwordHash },
        { email: `manager${DOMAIN}`, name: 'Settings Manager', role: 'manager', passwordHash },
      ],
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    admin = request.agent(app.getHttpServer());
    manager = request.agent(app.getHttpServer());
    await admin.post(`${API}/admin/auth/login`).send({ email: `admin${DOMAIN}`, password }).expect(200);
    await manager.post(`${API}/admin/auth/login`).send({ email: `manager${DOMAIN}`, password }).expect(200);
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await prisma.$disconnect();
  });

  it('managers read every section but save nothing, and never see system status', async () => {
    for (const path of ['venue', 'website', 'notifications', 'payments/status', 'notifications/log']) await manager.get(`${S}/${path}`).expect(200);
    await manager.put(`${S}/venue`).send({ name: 'Nope' }).expect(403);
    await manager.put(`${S}/website`).send({ social: { facebook: '', instagram: '', whatsapp: '' } }).expect(403);
    await manager.put(`${S}/notifications`).send({ staff: { dueDigest: false } }).expect(403);
    await manager.post(`${S}/venue/logo`).attach('logo', PNG, 'logo.png').expect(403);
    await manager.post(`${S}/reset`).send({ sections: ['website'] }).expect(403);
    await manager.get(`${API}/admin/system/status`).expect(403);
  });

  it('venue: defaults, save with audit, public copy refreshed at once', async () => {
    const first = await admin.get(`${S}/venue`).expect(200);
    expect(first.body.data).toMatchObject({ name: 'Champions Turf', logoUrl: null, locale: { currency: 'BDT', timezone: 'Asia/Dhaka', weekStartsOn: 'sat' }, updatedBy: null });
    expect((await request(app.getHttpServer()).get(`${API}/venue`).expect(200)).body.data.name).toBe('Champions Turf');

    const bad = await admin.put(`${S}/venue`).send({ mapUrl: 'http://maps.example.com' }).expect(400);
    expect(bad.body.details).toEqual([{ field: 'mapUrl', message: expect.stringContaining('https://') }]);

    const saved = await admin.put(`${S}/venue`).send({ name: 'Arena Dhaka', supportEmail: 'help@arena.test' }).expect(200);
    expect(saved.body.data).toMatchObject({ name: 'Arena Dhaka', supportEmail: 'help@arena.test', updatedBy: { name: 'Settings Admin' } });
    const pub = (await request(app.getHttpServer()).get(`${API}/venue`).expect(200)).body.data;
    expect(pub.name).toBe('Arena Dhaka');
    expect(pub).not.toHaveProperty('supportEmail');
    expect(pub).not.toHaveProperty('updatedBy');
    const event = await prisma.settingsEvent.findFirst({ where: { section: 'venue' }, orderBy: { createdAt: 'desc' } });
    expect(event?.fields.sort()).toEqual(['name', 'supportEmail']);
  });

  it('logo: PNG only, replacing deletes the old file, delete removes it', async () => {
    const svg = await admin.post(`${S}/venue/logo`).attach('logo', Buffer.from('<svg/>'), 'logo.svg').expect(400);
    expect(svg.body.code).toBe('INVALID_IMAGE_TYPE');
    expect((await admin.post(`${S}/venue/logo`).expect(400)).body.code).toBe('IMAGE_REQUIRED');
    const big = await admin.post(`${S}/venue/logo`).attach('logo', Buffer.concat([PNG, Buffer.alloc(210 * 1024)]), 'big.png').expect(400);
    expect(big.body.code).toBe('IMAGE_TOO_LARGE');

    const one = (await admin.post(`${S}/venue/logo`).attach('logo', PNG, 'logo.png').expect(201)).body.data.logoUrl;
    expect(existsSync(fileOf(one))).toBe(true);
    const two = (await admin.post(`${S}/venue/logo`).attach('logo', PNG, 'logo.png').expect(201)).body.data.logoUrl;
    expect(existsSync(fileOf(one))).toBe(false);
    await admin.delete(`${S}/venue/logo`).expect(200);
    expect(existsSync(fileOf(two))).toBe(false);
  });

  it('website: dotted validation paths, partial sections, image upload replaces the old file', async () => {
    const current = (await admin.get(`${S}/website`).expect(200)).body.data;
    const amenities = { ...current.sections.amenities, items: [{ icon: 'parking', label: '' }] };
    const bad = await admin.put(`${S}/website`).send({ sections: { amenities } }).expect(400);
    expect(bad.body.details[0].field).toBe('sections.amenities.items.0.label');

    const saved = await admin.put(`${S}/website`).send({ sections: { sportChips: { enabled: false, title: 'Sports' } } }).expect(200);
    expect(saved.body.data.sections.sportChips).toEqual({ enabled: false, title: 'Sports' });
    expect(saved.body.data.sections.amenities).toEqual(current.sections.amenities);

    const first = (await admin.post(`${S}/website/images/hero`).attach('image', WEBP, 'hero.webp').expect(201)).body.data.hero.imageUrl;
    expect(first).toMatch(/^\/api\/v1\/uploads\/website\/[0-9a-f-]{36}\.webp$/);
    const second = (await admin.post(`${S}/website/images/hero`).attach('image', PNG, 'hero.png').expect(201)).body.data.hero.imageUrl;
    expect(existsSync(fileOf(first))).toBe(false);
    expect(existsSync(fileOf(second))).toBe(true);
    await admin.post(`${S}/website/images/side`).attach('image', PNG, 'x.png').expect(400);

    const pub = (await request(app.getHttpServer()).get(`${API}/website`).expect(200)).body.data;
    expect(pub).toMatchObject({ hero: { imageUrl: second }, venue: { name: 'Arena Dhaka' } });
    expect(pub).not.toHaveProperty('updatedAt');
  });

  it('notifications: always-on emails, sender follows the venue, test email needs SendGrid', async () => {
    const res = await admin.get(`${S}/notifications`).expect(200);
    expect(res.body.data).toMatchObject({
      email: { configured: false, fromName: null, effectiveFromName: 'Arena Dhaka', effectiveReplyTo: 'help@arena.test' },
      customer: { bookingConfirmed: true, bookingCancelled: true, refundIssued: true },
      staff: { recipients: [], dueDigest: true },
    });
    const off = await admin.put(`${S}/notifications`).send({ customer: { bookingConfirmed: false } }).expect(400);
    expect(off.body.details[0].field).toBe('customer.bookingConfirmed');

    const saved = await admin.put(`${S}/notifications`).send({ email: { fromName: 'Arena Bookings' }, staff: { recipients: [`owner${DOMAIN}`], dueDigest: false } }).expect(200);
    expect(saved.body.data).toMatchObject({
      email: { fromName: 'Arena Bookings', effectiveFromName: 'Arena Bookings' }, staff: { recipients: [`owner${DOMAIN}`], dueDigest: false },
      updatedBy: { name: 'Settings Admin' },
    });
    const test = await admin.post(`${S}/notifications/test`).send({}).expect(400);
    expect(test.body.code).toBe('EMAIL_NOT_CONFIGURED');
  });

  it('email log: newest first, addresses masked', async () => {
    await prisma.emailLog.create({ data: { to: `rakib${DOMAIN}`, subject: 'Booking CT-1 confirmed', kind: 'booking_confirmed', ok: true, createdAt: new Date(Date.now() + 60_000) } });
    const res = await admin.get(`${S}/notifications/log`).query({ limit: 1 }).expect(200);
    expect(res.body.data.data[0]).toMatchObject({ to: `ra***${DOMAIN}`, subject: 'Booking CT-1 confirmed', kind: 'booking_confirmed', ok: true, error: null });
  });

  it('payments and system status show state, never secrets', async () => {
    const pay = await admin.get(`${S}/payments/status`).expect(200);
    expect(pay.body.data).toMatchObject({ stripe: { configured: false, mode: null, currency: 'bdt' }, methods: { card: false, cash: true, bankTransfer: true } });
    const sys = await admin.get(`${API}/admin/system/status`).expect(200);
    expect(sys.body.data).toMatchObject({ version: expect.any(String), database: { ok: true }, counts: { grounds: expect.any(Number) }, integrations: { stripe: false, sendgrid: false } });
    const all = JSON.stringify([pay.body, sys.body]);
    for (const secret of [env.DATABASE_URL, env.JWT_SECRET]) expect(all).not.toContain(secret);
  });

  it('reset puts the website back to defaults and leaves the venue alone', async () => {
    const res = await admin.post(`${S}/reset`).send({ sections: ['website'] }).expect(200);
    expect(res.body.data.website.sections.sportChips).toEqual({ enabled: true, title: 'Browse by sport' });
    expect(res.body.data).not.toHaveProperty('slots');
    expect((await admin.get(`${S}/venue`).expect(200)).body.data.name).toBe('Arena Dhaka');
    await admin.post(`${S}/reset`).send({ sections: ['grounds'] }).expect(400);
  });

  it('permissions follow the route guards', async () => {
    const res = await manager.get(`${API}/admin/auth/permissions`).expect(200);
    const { admin: forAdmin, manager: forManager } = res.body.data;
    expect(forAdmin).toEqual(expect.arrayContaining(['PUT /admin/settings/venue', 'GET /admin/system/status', 'GET /admin/bookings']));
    expect(forManager).toContain('GET /admin/bookings');
    expect(forManager).not.toContain('PUT /admin/settings/venue');
    expect(forManager).not.toContain('GET /admin/system/status');
  });
});
