import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { hashPassword } from './../src/auth/password.js';
import { EmailService } from './../src/email/email.service.js';
import { StripeService } from './../src/payments/stripe.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { SmsVerifyService } from './../src/sms/sms-verify.service.js';
import { addDays, toDbDate, venueNow } from './../src/slots/venue-time.js';

const API = '/api/v1';
const AUTH = `${API}/customer/auth`;
const PREFIX = 'E2E CustomerAuth';
const DOMAIN = '@customer-auth.test';
/** Every customer phone in this file starts with this, for cleanup. */
const PHONE = '+88017990010';
const LOCAL = '017990010';
const CODE = '123456';
const password = 'e2e-password-123';

const date = addDays(venueNow().date, 3);

const sms = {
  send: vi.fn(async () => undefined),
  check: vi.fn(async (_phone: string, code: string) => code === CODE),
};
const stripe = {
  createCheckoutSession: vi.fn(
    async ({ bookingId }: { bookingId: string }) => ({
      id: `cs_${bookingId}`,
      url: `https://stripe.test/${bookingId}`,
    }),
  ),
  openSessionUrl: vi.fn(async () => null),
  expireSession: vi.fn(async () => undefined),
};
const email = {
  configured: true,
  send: vi.fn(
    async (_message: { to: string; text: string; kind: string }) => true,
  ),
};

function emailCode(address: string, kind: string) {
  const message = email.send.mock.calls
    .map(([message]) => message)
    .reverse()
    .find((message) => message.to === address && message.kind === kind);
  const code = message?.text.match(/\b\d{6}\b/)?.[0];
  expect(code).toMatch(/^\d{6}$/);
  return code!;
}

describe('Customer sign-in (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let groundId: string;

  const cleanup = async () => {
    const grounds = await prisma.ground.findMany({
      where: { name: { startsWith: PREFIX } },
      select: { id: true },
    });
    const ids = grounds.map((g) => g.id);
    await prisma.bookingEvent.deleteMany({
      where: { booking: { groundId: { in: ids } } },
    });
    await prisma.payment.deleteMany({
      where: { booking: { groundId: { in: ids } } },
    });
    await prisma.bookingSlot.deleteMany({
      where: { booking: { groundId: { in: ids } } },
    });
    await prisma.booking.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.customer.deleteMany({
      where: { phone: { startsWith: PHONE } },
    });
    await prisma.slot.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.ground.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await cleanup();
    await prisma.user.create({
      data: {
        email: `admin${DOMAIN}`,
        name: 'Admin',
        role: 'admin',
        passwordHash: await hashPassword(password),
      },
    });
    groundId = (
      await prisma.ground.create({
        data: {
          name: `${PREFIX} Main`,
          sport: 'football',
          hourlyPrice: 1000,
          openingHour: 8,
          closingHour: 12,
        },
      })
    ).id;
    await prisma.slot.createMany({
      data: [8, 9, 10, 11].map((startHour) => ({
        groundId,
        date: toDbDate(date),
        startHour,
        price: 1000,
      })),
    });
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SmsVerifyService)
      .useValue(sms)
      .overrideProvider(StripeService)
      .useValue(stripe)
      .overrideProvider(EmailService)
      .useValue(email)
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterEach(() => app.close());

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  const http = () => request(app.getHttpServer());
  /** Guests can only pay by card; cash needs a signed-in customer (`agent`). */
  const checkout = (
    agent: ReturnType<typeof request.agent> | null,
    startHour: number,
    phone: string,
  ) =>
    (agent ?? http()).post(`${API}/checkout`).send({
      groundId,
      date,
      hour: startHour,
      customerName: 'Rakib Hasan',
      customerEmail: 'rakib@example.com',
      customerPhone: phone,
      paymentMethod: agent ? 'cash' : 'card',
    });

  async function signIn(phone: string) {
    const agent = request.agent(app.getHttpServer());
    await agent.post(`${AUTH}/send-code`).send({ phone }).expect(200);
    const res = await agent
      .post(`${AUTH}/verify`)
      .send({ phone, code: CODE })
      .expect(200);
    return {
      agent,
      session: res.body.data,
      cookie: res.headers['set-cookie'] as unknown as string[],
    };
  }

  it('validates the phone and the code', async () => {
    const bad = await http()
      .post(`${AUTH}/send-code`)
      .send({ phone: '12' })
      .expect(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');

    await http()
      .post(`${AUTH}/send-code`)
      .send({ phone: `${LOCAL}01` })
      .expect(200);
    expect(sms.send).toHaveBeenCalledWith(`${PHONE}01`);
    const wrong = await http()
      .post(`${AUTH}/verify`)
      .send({ phone: `${LOCAL}01`, code: '000000' })
      .expect(400);
    expect(wrong.body.code).toBe('INVALID_CODE');
  });

  it('signs in a new number with an httpOnly cookie', async () => {
    const { agent, session, cookie } = await signIn(`${LOCAL}02`);
    expect(session).toEqual({
      phone: `${PHONE}02`,
      customerId: null,
      name: null,
      email: null,
      needsProfile: true,
    });
    expect(cookie.join(';')).toMatch(/customer_token=.+HttpOnly/i);

    const me = await agent.get(`${AUTH}/me`).expect(200);
    expect(me.body.data.phone).toBe(`${PHONE}02`);
  });

  it('creates the customer from sign-up details, or on the profile step', async () => {
    const agent = request.agent(app.getHttpServer());
    const res = await agent
      .post(`${AUTH}/verify`)
      .send({
        phone: `${LOCAL}06`,
        code: CODE,
        name: 'Nadia Islam',
        email: 'nadia@example.com',
      })
      .expect(200);
    expect(res.body.data).toMatchObject({
      name: 'Nadia Islam',
      needsProfile: false,
    });
    expect(
      await prisma.customer.findUnique({ where: { phone: `${PHONE}06` } }),
    ).toMatchObject({ name: 'Nadia Islam', email: 'nadia@example.com' });

    const { agent: later } = await signIn(`${LOCAL}07`);
    const saved = await later
      .post(`${AUTH}/profile`)
      .send({ name: 'Arif Khan', email: 'Arif@Example.com' })
      .expect(200);
    expect(saved.body.data).toMatchObject({
      name: 'Arif Khan',
      email: 'arif@example.com',
      needsProfile: false,
    });
    expect(
      (await later.get(`${AUTH}/me`).expect(200)).body.data.customerId,
    ).toBe(saved.body.data.customerId);
    await http()
      .post(`${AUTH}/profile`)
      .send({ name: 'X', email: 'x@example.com' })
      .expect(401);
  });

  it('links a verified email, reuses the phone account, and consumes email codes only once', async () => {
    const address = `email-login-${randomUUID()}${DOMAIN}`;
    const { agent: phoneAgent } = await signIn(`${LOCAL}51`);
    const saved = await phoneAgent
      .post(`${AUTH}/profile`)
      .send({ name: 'Email customer', email: address })
      .expect(200);

    await http()
      .post(`${AUTH}/email/link/send-code`)
      .send({ email: address })
      .expect(401);

    await phoneAgent
      .post(`${AUTH}/email/link/send-code`)
      .send({ email: address })
      .expect(200);
    const linkCode = emailCode(address, 'customer_email_link');
    await http()
      .post(`${AUTH}/email/verify`)
      .send({ email: address, code: linkCode })
      .expect(400);
    const linked = await phoneAgent
      .post(`${AUTH}/email/link/verify`)
      .send({ email: address, code: linkCode })
      .expect(200);
    expect(linked.body.data).toMatchObject({
      verifiedEmail: address,
      customerId: saved.body.data.customerId,
    });

    const emailAgent = request.agent(app.getHttpServer());
    await emailAgent
      .post(`${AUTH}/email/send-code`)
      .send({ email: address.toUpperCase() })
      .expect(200);
    const signInCode = emailCode(address, 'customer_email_sign_in');

    const attempts = await Promise.all([
      emailAgent
        .post(`${AUTH}/email/verify`)
        .send({ email: address, code: signInCode }),
      http()
        .post(`${AUTH}/email/verify`)
        .send({ email: address, code: signInCode }),
    ]);
    expect(attempts.map(({ status }) => status).sort()).toEqual([200, 400]);
    await http()
      .post(`${AUTH}/email/verify`)
      .send({ email: address, code: signInCode })
      .expect(400);
    const signedIn = attempts.find(({ status }) => status === 200)!;
    expect(signedIn.body.data).toMatchObject({
      phone: `${PHONE}51`,
      customerId: saved.body.data.customerId,
      signInMethod: 'email',
    });
    const cookie = (
      signedIn.headers['set-cookie'] as unknown as string[]
    )[0].split(';', 1)[0];
    await http().get(`${AUTH}/me`).set('Cookie', cookie).expect(200);
    await http()
      .post(`${AUTH}/email/link/send-code`)
      .set('Cookie', cookie)
      .send({ email: address })
      .expect(403);
    await phoneAgent.post(`${AUTH}/logout`).expect(200);
    await http().get(`${AUTH}/me`).set('Cookie', cookie).expect(401);
  });

  it('creates an email-first account and keeps unverified contact-email bookings private', async () => {
    const address = `first-${randomUUID()}${DOMAIN}`;
    const existing = await prisma.customer.create({
      data: { name: 'Existing contact', phone: `${PHONE}52`, email: address },
    });
    const emailAgent = request.agent(app.getHttpServer());
    await emailAgent
      .post(`${AUTH}/email/send-code`)
      .send({ email: address })
      .expect(200);
    expect(
      await prisma.customer.findUnique({ where: { verifiedEmail: address } }),
    ).toBeNull();
    const code = emailCode(address, 'customer_email_sign_in');
    const verified = await emailAgent
      .post(`${AUTH}/email/verify`)
      .send({ email: address, code })
      .expect(200);
    expect(verified.body.data).toMatchObject({
      phone: null,
      email: address,
      needsProfile: true,
      signInMethod: 'email',
    });
    expect(verified.body.data.customerId).not.toBe(existing.id);
    const firstId = verified.body.data.customerId;
    const cookie = (
      verified.headers['set-cookie'] as unknown as string[]
    )[0].split(';', 1)[0];
    await emailAgent.get(`${AUTH}/me`).expect(200);
    await emailAgent
      .get(`${API}/customer/bookings`)
      .expect(200)
      .expect(({ body }) => expect(body.data.total).toBe(0));
    await emailAgent
      .post(`${AUTH}/profile`)
      .send({ name: 'Email first', email: address })
      .expect(200)
      .expect(({ body }) =>
        expect(body.data).toMatchObject({ phone: null, needsProfile: false }),
      );
    await emailAgent
      .post(`${AUTH}/verify`)
      .send({ phone: `${LOCAL}52`, code: '000000', linkPhone: true })
      .expect(400);
    await emailAgent
      .post(`${AUTH}/verify`)
      .send({ phone: `${LOCAL}52`, code: CODE, linkPhone: true })
      .expect(200)
      .expect(({ body }) =>
        expect(body.data).toMatchObject({
          phone: `${PHONE}52`,
          customerId: existing.id,
          signInMethod: 'email',
        }),
      );
    await http().get(`${AUTH}/me`).set('Cookie', cookie).expect(401);
    await emailAgent.get(`${AUTH}/me`).expect(200);
    // The disposable test database also contains the superseded email-only identity.
    await prisma.customer.delete({ where: { id: firstId } });
  });

  it('lists guest bookings made with the number, with their signed links', async () => {
    const guest = await checkout(null, 8, `${LOCAL}03`).expect(201);
    const { agent, session } = await signIn(`${LOCAL}03`);
    expect(session).toMatchObject({
      name: 'Rakib Hasan',
      email: 'rakib@example.com',
    });

    const upcoming = await agent.get(`${API}/customer/bookings`).expect(200);
    expect(upcoming.body.data).toMatchObject({ total: 1, page: 1 });
    expect(upcoming.body.data.data[0]).toMatchObject({
      id: guest.body.data.bookingId,
      status: 'pending',
      payAtVenue: false,
      canCancel: true,
      canPay: false,
      confirmationUrl: guest.body.data.confirmationUrl,
    });
    const past = await agent
      .get(`${API}/customer/bookings`)
      .query({ scope: 'past' })
      .expect(200);
    expect(past.body.data.total).toBe(0);
  });

  it('books a signed-in customer on their verified number and updates their details', async () => {
    const { agent } = await signIn(`${LOCAL}04`);
    const res = await checkout(agent, 9, `${LOCAL}99`).expect(201);
    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: res.body.data.bookingId },
      include: { customer: true },
    });
    expect(booking.contactPhone).toBe(`${PHONE}04`);
    expect(booking.customer).toMatchObject({
      phone: `${PHONE}04`,
      name: 'Rakib Hasan',
    });

    const mine = await agent.get(`${API}/customer/bookings`).expect(200);
    expect(mine.body.data.total).toBe(1);
  });

  it('needs a customer session: none, or a staff one, is 401', async () => {
    await http().get(`${API}/customer/bookings`).expect(401);
    const login = await http()
      .post(`${API}/admin/auth/login`)
      .send({ email: `admin${DOMAIN}`, password })
      .expect(200);
    const staffToken = /admin_token=([^;]+)/.exec(
      String(login.headers['set-cookie']),
    )![1];
    const res = await http()
      .get(`${AUTH}/me`)
      .set('Cookie', `customer_token=${staffToken}`)
      .expect(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('logout revokes the session everywhere', async () => {
    await checkout(null, 10, `${LOCAL}05`).expect(201);
    const { agent, cookie } = await signIn(`${LOCAL}05`);
    await agent.post(`${AUTH}/logout`).expect(200);
    await agent.get(`${AUTH}/me`).expect(401);
    // The old cookie, replayed from another device, no longer works either.
    await http()
      .get(`${AUTH}/me`)
      .set('Cookie', cookie.map((c) => c.split(';')[0]!).join('; '))
      .expect(401);
  });
});
