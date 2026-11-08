import { randomBytes } from 'node:crypto';
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
import { addDays, toDbDate, venueNow } from './../src/slots/venue-time.js';
import { signInCustomer } from './sign-in-customer.js';

const API = '/api/v1';
const DOMAIN = '@wallet-race.test';
const PREFIX = 'E2E Wallet Race';
/** Every customer phone in this file starts with this, for cleanup. */
const PHONE = '+88017990042';
const ROUNDS = 8;
const password = 'e2e-password-123';
const managers = [`one${DOMAIN}`, `two${DOMAIN}`];

const date = addDays(venueNow().date, 2);

const stripe = {
  createCheckoutSession: vi.fn(), openSessionUrl: vi.fn(async () => null), expireSession: vi.fn(async () => undefined),
  refund: vi.fn(async (intentId: string) => `re_${intentId}`), cardLast4: vi.fn(async () => null), parseWebhook: vi.fn(),
};
const email = { send: vi.fn(async () => true) };

/** Two staff members click Verify and Reject on the same bKash payment at the same moment. */
describe('bKash verify vs reject race (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let groundId: string;

  const cleanup = async () => {
    const ids = (await prisma.ground.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((g) => g.id);
    await prisma.bookingEvent.deleteMany({ where: { booking: { groundId: { in: ids } } } });
    await prisma.payment.deleteMany({ where: { booking: { groundId: { in: ids } } } });
    await prisma.booking.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { phone: { startsWith: PHONE } } });
    await prisma.slot.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.ground.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await cleanup();
    const passwordHash = await hashPassword(password);
    await prisma.user.createMany({ data: managers.map((email, i) => ({ email, name: `Manager ${i}`, role: 'manager' as const, passwordHash })) });
    groundId = (await prisma.ground.create({
      data: { name: `${PREFIX} Main`, sport: 'football', hourlyPrice: 1000, openingHour: 6, closingHour: 6 + ROUNDS },
    })).id;
    await prisma.slot.createMany({ data: Array.from({ length: ROUNDS }, (_, i) => ({ groundId, date: toDbDate(date), startHour: 6 + i, price: 1000 })) });
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeService).useValue(stripe).overrideProvider(EmailService).useValue(email).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterEach(() => app.close());

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent.post(`${API}/admin/auth/login`).send({ email, password }).expect(200);
    return agent;
  };

  it('one action wins cleanly every time; a cancelled booking never keeps a received payment', async () => {
    const [verifier, rejecter] = await Promise.all(managers.map(signIn));
    const outcomes = { verified: 0, rejected: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      await prisma.slotSettings.upsert({ where: { id: 1 }, create: { id: 1, bkashNumber: '+8801700000042' }, update: { bkashNumber: '+8801700000042' } });
      // A signed-in customer per round: bKash needs sign-in, and checkout allows 5 per 10 minutes per phone.
      const customerPhone = `017990042${String(round + 1).padStart(2, '0')}`;
      const created = await (await signInCustomer(app, customerPhone)).post(`${API}/checkout`).send({
        groundId, date, hour: 6 + round, customerName: 'Race Runner', customerEmail: 'race@wallet-race.test', customerPhone,
        paymentMethod: 'bkash', reference: `X${randomBytes(5).toString('hex').toUpperCase()}`, payerNumber: '01811000042',
      }).expect(201);
      const id = created.body.data.bookingId as string;

      const [verify, reject] = await Promise.all([
        verifier.post(`${API}/admin/bookings/${id}/confirm`).send({ notifyCustomer: false }),
        rejecter.post(`${API}/admin/bookings/${id}/cancel`).send({ refund: false, notifyCustomer: false, rejectWalletPayment: true }),
      ]);
      expect([verify.status, reject.status].sort()).toEqual([200, 409]);
      expect([verify.body.code, reject.body.code].filter(Boolean)).toHaveLength(1);

      const row = await prisma.booking.findUniqueOrThrow({ where: { id }, include: { payments: true, slot: true } });
      const [payment] = row.payments;
      if (verify.status === 200) {
        outcomes.verified += 1;
        expect(row).toMatchObject({ status: 'confirmed', paymentStatus: 'paid', liveSlotId: row.slotId });
        expect(payment).toMatchObject({ status: 'succeeded', receivedAt: expect.any(Date) });
        expect(row.slot.status).toBe('booked');
      } else {
        outcomes.rejected += 1;
        expect(row).toMatchObject({ status: 'cancelled', paymentStatus: 'failed', liveSlotId: null });
        expect(payment).toMatchObject({ status: 'failed', receivedAt: null });
        expect(row.slot.status).toBe('available');
      }
      expect(row.payments).toHaveLength(1);
    }
    // Across every round: no cancelled booking holds a succeeded, unrefunded payment.
    const broken = await prisma.booking.count({ where: { groundId, status: 'cancelled', payments: { some: { status: 'succeeded' } } } });
    expect(broken).toBe(0);
    expect(outcomes.verified + outcomes.rejected).toBe(ROUNDS);
  });
});
