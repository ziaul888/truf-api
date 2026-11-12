import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { env } from '../src/config/env.js';
import { EmailService } from '../src/email/email.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const AUTH = '/api/v1/customer/auth';
const PHONE_PREFIX = '+88017990077';
const PHONE = `${PHONE_PREFIX}01`;
const LOCAL = '01799007701';
const CODE = '87654321';
const KEYS = ['LIVE_TEST_PHONE', 'LIVE_TEST_OTP', 'TEST_OTP_CODE', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SERVICE_SID'] as const;

describe('Dedicated live test login (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const original: Partial<Record<(typeof KEYS)[number], string>> = Object.fromEntries(KEYS.map((key) => [key, env[key]]));
  const provider = vi.fn(async () => new Response(JSON.stringify({ status: 'pending' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }));

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.customer.deleteMany({ where: { phone: { startsWith: PHONE_PREFIX } } });
    Object.assign(env, {
      LIVE_TEST_PHONE: PHONE, LIVE_TEST_OTP: CODE,
      TWILIO_ACCOUNT_SID: 'AC_e2e', TWILIO_AUTH_TOKEN: 'e2e', TWILIO_VERIFY_SERVICE_SID: 'VA_e2e',
    });
    delete env.TEST_OTP_CODE;
    vi.stubGlobal('fetch', provider);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailService).useValue({ send: vi.fn(async () => true) }).compile();
    app = configureApp(module.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await prisma.customer.deleteMany({ where: { phone: { startsWith: PHONE_PREFIX } } });
      await prisma.$disconnect();
    }
    for (const key of KEYS) {
      const value = original[key];
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    vi.unstubAllGlobals();
  });

  it('normalizes the phone, sends no SMS, rejects the wrong code, and creates an ordinary customer session', async () => {
    provider.mockClear();
    const agent = request.agent(app.getHttpServer());
    await agent.post(`${AUTH}/send-code`).send({ phone: LOCAL }).expect(200);
    const wrong = await agent.post(`${AUTH}/verify`).send({ phone: LOCAL, code: '00000000' }).expect(400);
    expect(wrong.body.code).toBe('INVALID_CODE');
    const verified = await agent.post(`${AUTH}/verify`).send({ phone: LOCAL, code: CODE }).expect(200);
    expect(verified.body.data).toMatchObject({ phone: PHONE, needsProfile: true });
    expect(String(verified.headers['set-cookie'])).toMatch(/customer_token=.+HttpOnly/i);
    await agent.post(`${AUTH}/profile`).send({ name: 'Live Test Customer', email: 'customer@live-test-login.test' }).expect(200);
    const me = await agent.get(`${AUTH}/me`).expect(200);
    expect(me.body.data).toMatchObject({ phone: PHONE, name: 'Live Test Customer', needsProfile: false });
    await agent.get('/api/v1/admin/bookings').expect(401);
    expect(provider).not.toHaveBeenCalled();
  });

  it('uses the provider for other numbers and rejects the fixed code for them', async () => {
    provider.mockClear();
    const phone = `${PHONE_PREFIX}02`;
    const http = request(app.getHttpServer());
    await http.post(`${AUTH}/send-code`).send({ phone }).expect(200);
    const verify = await http.post(`${AUTH}/verify`).send({ phone, code: CODE }).expect(400);
    expect(verify.body.code).toBe('INVALID_CODE');
    expect(provider).toHaveBeenCalledTimes(2);
    expect(await prisma.customer.findUnique({ where: { phone } })).toBeNull();
  });

  it('stops fixed-code login when the configuration pair is removed', async () => {
    delete env.LIVE_TEST_PHONE;
    delete env.LIVE_TEST_OTP;
    try {
      const verify = await request(app.getHttpServer()).post(`${AUTH}/verify`).send({ phone: LOCAL, code: CODE }).expect(400);
      expect(verify.body.code).toBe('INVALID_CODE');
    } finally {
      env.LIVE_TEST_PHONE = PHONE;
      env.LIVE_TEST_OTP = CODE;
    }
  });

  it('retains the existing OTP attempt limit', async () => {
    const phone = `${PHONE_PREFIX}03`;
    env.LIVE_TEST_PHONE = phone;
    provider.mockClear();
    try {
      const http = request(app.getHttpServer());
      for (let i = 0; i < 5; i++) await http.post(`${AUTH}/verify`).send({ phone, code: '00000000' }).expect(400);
      const blocked = await http.post(`${AUTH}/verify`).send({ phone, code: '00000000' }).expect(429);
      expect(blocked.body.code).toBe('TOO_MANY_ATTEMPTS');
      expect(provider).not.toHaveBeenCalled();
    } finally {
      env.LIVE_TEST_PHONE = PHONE;
    }
  });
});
