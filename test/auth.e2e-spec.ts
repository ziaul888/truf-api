import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { hashPassword } from './../src/auth/password.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

const LOGIN = '/api/v1/admin/auth/login';
const ME = '/api/v1/admin/auth/me';
const LOGOUT = '/api/v1/admin/auth/logout';
const CHANGE_PASSWORD = '/api/v1/admin/auth/change-password';

const admin = { email: 'e2e-admin@auth.test', password: 'e2e-password-123' };
const inactive = { email: 'e2e-inactive@auth.test', password: 'e2e-password-123' };

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    const passwordHash = await hashPassword(admin.password);
    await prisma.user.deleteMany({ where: { email: { endsWith: '@auth.test' } } });
    await prisma.user.createMany({
      data: [
        { email: admin.email, name: 'E2E Admin', role: 'admin', passwordHash },
        { email: inactive.email, name: 'E2E Inactive', role: 'manager', passwordHash, isActive: false },
      ],
    });
  });

  // A fresh app per test also resets the in-memory login rate limit.
  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { endsWith: '@auth.test' } } });
    await prisma.$disconnect();
  });

  const login = (body: object) => request(app.getHttpServer()).post(LOGIN).send(body);

  it('logs in, sets an httpOnly admin_token cookie, and never returns the hash', async () => {
    const res = await login({ email: '  E2E-Admin@auth.test ', password: admin.password }).expect(200);

    expect(res.body).toEqual({
      success: true,
      data: { id: expect.any(String), email: admin.email, name: 'E2E Admin', role: 'admin' },
    });
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/^admin_token=.+; Max-Age=28800; Path=\/; Expires=.+; HttpOnly; SameSite=Lax$/);
  });

  it('GET /me returns the user with the cookie, 401 without', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post(LOGIN).send(admin).expect(200);

    const me = await agent.get(ME).expect(200);
    expect(me.body.data).toMatchObject({ email: admin.email, role: 'admin' });

    const anon = await request(app.getHttpServer()).get(ME).expect(401);
    expect(anon.body).toEqual({ success: false, error: 'Please sign in', code: 'UNAUTHENTICATED' });
  });

  it('logout revokes the token, so a copied cookie stops working', async () => {
    const login1 = await login(admin).expect(200);
    const stolen = login1.headers['set-cookie']![0]!.split(';')[0]!;
    await request(app.getHttpServer()).get(ME).set('Cookie', stolen).expect(200);

    await request(app.getHttpServer()).post(LOGOUT).set('Cookie', stolen).expect(200);
    await request(app.getHttpServer()).get(ME).set('Cookie', stolen).expect(401);
  });

  it('change-password keeps this session, revokes others, and the new password works', async () => {
    const other = request.agent(app.getHttpServer());
    await other.post(LOGIN).send(admin).expect(200);
    const me = request.agent(app.getHttpServer());
    await me.post(LOGIN).send(admin).expect(200);

    const newPassword = 'a-different-password-456';
    const wrong = await me.post(CHANGE_PASSWORD).send({ currentPassword: 'nope', newPassword }).expect(400);
    expect(wrong.body.code).toBe('WRONG_PASSWORD');

    await me.post(CHANGE_PASSWORD).send({ currentPassword: admin.password, newPassword }).expect(200);
    await me.get(ME).expect(200);
    await other.get(ME).expect(401);
    await login(admin).expect(401);
    await login({ email: admin.email, password: newPassword }).expect(200);

    // Put it back for the other tests.
    await me.post(CHANGE_PASSWORD).send({ currentPassword: newPassword, newPassword: admin.password }).expect(200);
  });

  it('logout clears the cookie', async () => {
    const res = await request(app.getHttpServer()).post(LOGOUT).expect(200);
    expect(res.body).toEqual({ success: true, data: { loggedOut: true } });
    expect(res.headers['set-cookie']?.[0]).toMatch(/^admin_token=; Path=\/; Expires=Thu, 01 Jan 1970/);
  });

  it.each([
    ['a wrong password', { email: admin.email, password: 'wrong-password' }],
    ['an unknown email', { email: 'nobody@auth.test', password: admin.password }],
    ['a deactivated user', inactive],
  ])('rejects %s with the same 401', async (_label, body) => {
    const res = await login(body).expect(401);
    expect(res.body).toEqual({ success: false, error: 'Invalid email or password', code: 'INVALID_CREDENTIALS' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('validates the body', async () => {
    const res = await login({ email: 'not-an-email' }).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.details).toEqual([
      { field: 'email', message: 'Enter a valid email' },
      { field: 'password', message: 'This field is required' },
    ]);
  });

  it('allows 5 login attempts per minute per email, then 429', async () => {
    for (let i = 0; i < 5; i++) await login({ email: admin.email, password: 'wrong' }).expect(401);

    const res = await login(admin).expect(429);
    expect(res.body).toMatchObject({ success: false, code: 'TOO_MANY_ATTEMPTS' });

    // Another email is tracked separately.
    await login({ email: inactive.email, password: 'wrong' }).expect(401);
  });
});
