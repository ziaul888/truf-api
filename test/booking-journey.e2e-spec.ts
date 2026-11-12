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
const DOMAIN = '@journey.test';
const PREFIX = 'E2E Journey';
/** Every customer phone in this file starts with this, for cleanup. */
const PHONE = '+88017990070';
const password = 'e2e-password-123';
const manager = { email: `manager${DOMAIN}`, password };

const today = venueNow().date;
const day = addDays(today, 2);
const trx = () => `J${randomBytes(5).toString('hex').toUpperCase()}`;

const stripe = {
  createCheckoutSession: vi.fn(async ({ bookingId }: { bookingId: string }) => ({ id: `cs_${bookingId}`, url: `https://stripe.test/${bookingId}` })),
  openSessionUrl: vi.fn(async () => null), expireSession: vi.fn(async () => undefined),
  refund: vi.fn(async (intentId: string) => `re_${intentId}`), cardLast4: vi.fn(async () => '4242'), parseWebhook: vi.fn(),
};
const email = { send: vi.fn(async (_m: { to: string; subject: string }) => true) };

/**
 * A customer's whole journey on the portal, and the staff side of it, ending in the sales report.
 * On one day, signed-in customers book:
 * - 08:00 cash at the venue: staff confirm, then collect it in cash (counts as revenue)
 * - 09:00 bKash with a TrxID: under review, then staff verify it (counts on the day verified)
 * - 10:00 bKash with a TrxID that staff can't find: they reject it (cancelled, nothing counts, the slot is free again)
 * - 11:00 cash at the venue: paid, then cancelled with a refund (received and refunded: nets 0)
 * No-show is left out: it needs a slot that has started (no-show.e2e-spec.ts). Nagad takes the same path as
 * bKash and is covered in wallet-payments.e2e-spec.ts; only the bKash number is set here, as other files do.
 */
describe('Booking journey to the sales report (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let groundId: string;

  const cleanup = async () => {
    const ids = (await prisma.ground.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((g) => g.id);
    await prisma.bookingEvent.deleteMany({ where: { booking: { groundId: { in: ids } } } });
    await prisma.payment.deleteMany({ where: { booking: { groundId: { in: ids } } } });
    await prisma.bookingSlot.deleteMany({ where: { booking: { groundId: { in: ids } } } });
    await prisma.booking.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { phone: { startsWith: PHONE } } });
    await prisma.slotEvent.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.slot.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.ground.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await cleanup();
    const passwordHash = await hashPassword(password);
    await prisma.user.createMany({
      data: [
        { email: manager.email, name: 'Manager', role: 'manager', passwordHash },
        { email: `admin${DOMAIN}`, name: 'Admin', role: 'admin', passwordHash },
      ],
    });
    groundId = (await prisma.ground.create({
      data: { name: `${PREFIX} Main`, sport: 'football', hourlyPrice: 1000, openingHour: 8, closingHour: 12 },
    })).id;
    await prisma.slot.createMany({ data: [8, 9, 10, 11].map((startHour) => ({ groundId, date: toDbDate(day), startHour, price: 1000 })) });
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

  const http = () => request(app.getHttpServer());
  const staff = async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post(`${API}/admin/auth/login`).send(manager).expect(200);
    return agent;
  };
  /** A signed-in customer (one phone per hour) checks out from the portal. */
  const checkout = async (hour: number, payment: { paymentMethod: string; reference?: string; payerNumber?: string }, status = 201) => {
    const customerPhone = `017990070${String(hour).padStart(2, '0')}`;
    const customer = await signInCustomer(app, customerPhone);
    // Set right before: wallet-payments.e2e-spec.ts clears the shared numbers while files run in parallel.
    if (payment.paymentMethod === 'bkash') {
      await prisma.slotSettings.upsert({ where: { id: 1 }, create: { id: 1, bkashNumber: '+8801700000070' }, update: { bkashNumber: '+8801700000070' } });
    }
    return customer.post(`${API}/checkout`).send({ groundId, date: day, hour, customerName: 'Rafi Hasan', customerPhone, ...payment }).expect(status);
  };
  const detail = async (id: string) => (await (await staff()).get(`${API}/admin/bookings/${id}`).expect(200)).body.data;
  const freeHours = async () => {
    const res = await http().get(`${API}/grounds/${groundId}/slots`).query({ date: day }).expect(200);
    return res.body.data.filter((s: { available: boolean }) => s.available).map((s: { startHour: number }) => s.startHour);
  };
  /** This file's ground in the report: money is dated by when it moved (today), bookings by slot date. */
  const report = async () => {
    const res = await (await staff()).get(`${API}/admin/reports/grounds`).query({ from: today, to: day }).expect(200);
    return res.body.data.find((g: { groundId: string }) => g.groundId === groundId);
  };

  const ids: Record<'cash' | 'bkash' | 'rejected' | 'refunded', string> = { cash: '', bkash: '', rejected: '', refunded: '' };
  const totals: Record<keyof typeof ids, number> = { cash: 0, bkash: 0, rejected: 0, refunded: 0 };

  it('all four hours are open to begin with', async () => {
    expect(await freeHours()).toEqual([8, 9, 10, 11]);
  });

  it('cash at the venue: waits for staff, who confirm it and collect the money', async () => {
    const res = await checkout(8, { paymentMethod: 'cash' });
    expect(res.body.data).toMatchObject({ paymentMethod: 'cash', checkoutUrl: null, confirmationUrl: expect.any(String) });
    ids.cash = res.body.data.bookingId;
    const booked = await detail(ids.cash);
    expect(booked).toMatchObject({ status: 'pending', payAtVenue: true, paid: 0 });
    totals.cash = booked.total;
    expect(booked.due).toBe(totals.cash);
    // The hour is taken: another customer can't book it.
    expect((await checkout(8, { paymentMethod: 'cash' }, 409)).body.code).toBe('SLOT_NOT_AVAILABLE');

    const agent = await staff();
    await agent.post(`${API}/admin/bookings/${ids.cash}/confirm`).send({ notifyCustomer: false }).expect(200);
    await agent.post(`${API}/admin/bookings/${ids.cash}/payments`).send({ amount: totals.cash, method: 'cash' }).expect(201);
    expect(await detail(ids.cash)).toMatchObject({ status: 'confirmed', paymentStatus: 'paid', paid: totals.cash, due: 0 });
  });

  it('bKash: under review counts nothing, then staff verify it', async () => {
    const res = await checkout(9, { paymentMethod: 'bkash', reference: trx(), payerNumber: '01811000070' });
    ids.bkash = res.body.data.bookingId;
    const review = await detail(ids.bkash);
    expect(review).toMatchObject({ status: 'pending', paid: 0 });
    expect(review.payments.map((p: { method: string; status: string }) => [p.method, p.status])).toEqual([['bkash', 'pending']]);
    totals.bkash = review.total;
    expect((await report()).revenue).toBe(totals.cash);

    await (await staff()).post(`${API}/admin/bookings/${ids.bkash}/confirm`).send({ notifyCustomer: false }).expect(200);
    expect(await detail(ids.bkash)).toMatchObject({ status: 'confirmed', paymentStatus: 'paid', paid: totals.bkash });
  });

  it('bKash with a TrxID staff cannot find: they reject it, the booking is cancelled and the hour opens again', async () => {
    const res = await checkout(10, { paymentMethod: 'bkash', reference: trx(), payerNumber: '01911000070' });
    ids.rejected = res.body.data.bookingId;
    totals.rejected = (await detail(ids.rejected)).total;
    expect(await freeHours()).toEqual([11]);

    await (await staff()).post(`${API}/admin/bookings/${ids.rejected}/cancel`)
      .send({ reason: 'No such TrxID in our bKash app', refund: false, rejectWalletPayment: true, notifyCustomer: false }).expect(200);
    const rejected = await detail(ids.rejected);
    expect(rejected).toMatchObject({ status: 'cancelled', paid: 0 });
    expect(rejected.payments.map((p: { status: string }) => p.status)).toEqual(['failed']);
    expect(await freeHours()).toEqual([10, 11]);
  });

  it('cash, paid, then cancelled with a refund', async () => {
    const res = await checkout(11, { paymentMethod: 'cash' });
    ids.refunded = res.body.data.bookingId;
    totals.refunded = (await detail(ids.refunded)).total;
    const agent = await staff();
    await agent.post(`${API}/admin/bookings/${ids.refunded}/confirm`).send({ notifyCustomer: false }).expect(200);
    await agent.post(`${API}/admin/bookings/${ids.refunded}/payments`).send({ amount: totals.refunded, method: 'cash' }).expect(201);
    await agent.post(`${API}/admin/bookings/${ids.refunded}/cancel`).send({ reason: 'Rain', refund: true, notifyCustomer: false }).expect(200);
    const cancelled = await detail(ids.refunded);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.payments.map((p: { status: string }) => p.status)).toEqual(['refunded']);
    expect(await freeHours()).toEqual([10, 11]);
  });

  it('the sales report matches the bookings: kept money only, every booking counted', async () => {
    expect(await report()).toMatchObject({
      revenue: totals.cash + totals.bkash,
      bookings: 4,
      cancelled: 2,
      hoursBooked: 2,
    });
  });

  it("the customer's own list shows their booking", async () => {
    const customer = await signInCustomer(app, '01799007008');
    const res = await customer.get(`${API}/customer/bookings`).expect(200);
    const list = res.body.data.data ?? res.body.data;
    expect(list.map((b: { id: string }) => b.id)).toContain(ids.cash);
  });
});
