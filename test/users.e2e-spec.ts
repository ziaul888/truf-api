import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { hashPassword } from './../src/auth/password.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

const USERS = '/api/v1/admin/users';
const LOGIN = '/api/v1/admin/auth/login';
const DOMAIN = '@users.test';
const password = 'e2e-password-123';
const admin = { email: `admin${DOMAIN}`, password };
const manager = { email: `manager${DOMAIN}`, password };

describe('Users (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminId: string;
  let managerId: string;

  const cleanup = () => prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await cleanup();
    const passwordHash = await hashPassword(password);
    adminId = (await prisma.user.create({ data: { email: admin.email, name: 'Admin', role: 'admin', passwordHash } })).id;
    managerId = (await prisma.user.create({ data: { email: manager.email, name: 'Manager', role: 'manager', passwordHash } })).id;
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
  });

  async function signIn(creds: { email: string; password: string }) {
    const agent = request.agent(app.getHttpServer());
    await agent.post(LOGIN).send(creds).expect(200);
    return agent;
  }

  it('requires sign-in (401) and the admin role (403)', async () => {
    await request(app.getHttpServer()).get(USERS).expect(401);
    const res = await (await signIn(manager)).get(USERS).expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('creates a manager (201) and rejects the same email again (409)', async () => {
    const asAdmin = await signIn(admin);
    const body = { email: `  New.Manager${DOMAIN} `, name: 'New Manager', password: 'a-strong-password' };

    const res = await asAdmin.post(USERS).send(body).expect(201);
    expect(res.body.data).toEqual({
      id: expect.any(String), email: `new.manager${DOMAIN}`, name: 'New Manager', role: 'manager',
      isActive: true, createdAt: expect.any(String), updatedAt: expect.any(String),
    });

    const dup = await asAdmin.post(USERS).send(body).expect(409);
    expect(dup.body.code).toBe('EMAIL_TAKEN');

    // The new account can sign in.
    await signIn({ email: `new.manager${DOMAIN}`, password: 'a-strong-password' });
  });

  it('validates input with readable messages', async () => {
    const res = await (await signIn(admin)).post(USERS).send({ email: 'x', password: 'short', role: 'owner' }).expect(400);
    expect(res.body.details).toEqual([
      { field: 'email', message: 'Enter a valid email' },
      { field: 'name', message: 'This field is required' },
      { field: 'password', message: 'Password must be at least 12 characters' },
      { field: 'role', message: 'Role must be admin or manager' },
    ]);
  });

  it('lists with pagination and search', async () => {
    const res = await (await signIn(admin)).get(USERS).query({ search: 'ADMIN@users', limit: 5 }).expect(200);
    expect(res.body.data).toMatchObject({ page: 1, limit: 5, total: 1 });
    expect(res.body.data.data[0]).toMatchObject({ email: admin.email });
    expect(res.body.data.data[0]).not.toHaveProperty('passwordHash');
  });

  it('gets one user, 404 for unknown, 400 for a malformed id', async () => {
    const asAdmin = await signIn(admin);
    await asAdmin.get(`${USERS}/${managerId}`).expect(200);
    const missing = await asAdmin.get(`${USERS}/00000000-0000-4000-8000-000000000000`).expect(404);
    expect(missing.body.code).toBe('USER_NOT_FOUND');
    await asAdmin.get(`${USERS}/not-a-uuid`).expect(400);
  });

  it('deactivating a user signs them out immediately', async () => {
    const asManager = await signIn(manager);
    const asAdmin = await signIn(admin);

    await asAdmin.patch(`${USERS}/${managerId}`).send({ isActive: false }).expect(200);
    await asManager.get('/api/v1/admin/auth/me').expect(401);
    await request(app.getHttpServer()).post(LOGIN).send(manager).expect(401);

    await asAdmin.patch(`${USERS}/${managerId}`).send({ isActive: true }).expect(200);
  });

  it('stops an admin from demoting or deactivating themselves', async () => {
    const asAdmin = await signIn(admin);
    const res = await asAdmin.patch(`${USERS}/${adminId}`).send({ role: 'manager' }).expect(400);
    expect(res.body.code).toBe('CANNOT_CHANGE_OWN_ACCESS');
    await asAdmin.patch(`${USERS}/${adminId}`).send({}).expect(400);
  });

  it('reset-password sets a new password and signs the user out', async () => {
    const asManager = await signIn(manager);
    const asAdmin = await signIn(admin);

    await asAdmin.post(`${USERS}/${managerId}/reset-password`).send({ password: 'reset-password-789' }).expect(200);
    await asManager.get('/api/v1/admin/auth/me').expect(401);
    await signIn({ email: manager.email, password: 'reset-password-789' });

    await asAdmin.post(`${USERS}/${managerId}/reset-password`).send({ password }).expect(200);
  });
});
