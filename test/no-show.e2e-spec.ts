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
const DOMAIN = '@no-show.test';
const PREFIX = 'E2E No Show';
/** Every customer phone in this file starts with this, for cleanup. */
const PHONE = '+88017990060';
const manager = { email: `manager${DOMAIN}`, password: 'e2e-password-123' };

const now = venueNow();
const hourNow = Math.floor(now.minutes / 60);
const d1 = addDays(now.date, 2);
const yesterday = addDays(now.date, -1);
/** A local phone per booking, so no customer total or open-booking cap mixes them up. */
const phoneOf = (n: number) => `017990060${String(n).padStart(2, '0')}`;

const stripe = {
  createCheckoutSession: vi.fn(async ({ bookingId }: { bookingId: string }) => ({ id: `cs_${bookingId}`, url: `https://stripe.test/${bookingId}` })),
  openSessionUrl: vi.fn(async () => null), expireSession: vi.fn(async () => undefined),
  refund: vi.fn(async (intentId: string) => `re_${intentId}`), cardLast4: vi.fn(async () => '4242'), parseWebhook: vi.fn(),
};

describe('No-show (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let groundId: string;
  /** One staff sign-in for the whole file: the login endpoint allows 5 attempts per 15 minutes. */
  let staffAgent: ReturnType<typeof request.agent>;

  const cleanup = async () => {
    const ids = (await prisma.ground.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((g) => g.id);
    await prisma.bookingEvent.deleteMany({ where: { booking: { groundId: { in: ids } } } });
    await prisma.payment.deleteMany({ where: { booking: { groundId: { in: ids } } } });
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
    await prisma.user.create({ data: { email: manager.email, name: 'Manager', role: 'manager', passwordHash: await hashPassword(manager.password) } });
    groundId = (await prisma.ground.create({
      data: { name: `${PREFIX} Main`, sport: 'football', hourlyPrice: 1000, openingHour: 0, closingHour: 24 },
    })).id;
    // Only d1 is seeded: bookings are made there, then their slot is moved into the past.
    await prisma.slot.createMany({ data: Array.from({ length: 16 }, (_, i) => ({ groundId, date: toDbDate(d1), startHour: 6 + i, price: 1000 })) });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeService).useValue(stripe).overrideProvider(EmailService).useValue({ send: vi.fn(async () => true) })
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    staffAgent = request.agent(app.getHttpServer());
    await staffAgent.post(`${API}/admin/auth/login`).send(manager).expect(200);
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await prisma.$disconnect();
  });

  const staff = async () => staffAgent;
  const slotAt = (hour: number) => prisma.slot.findFirstOrThrow({ where: { groundId, date: toDbDate(d1), startHour: hour } });
  /** A staff booking at `hour` on d1; `advance` records that much cash now (partial). */
  const staffBooking = async (hour: number, n: number, advance?: number) => {
    const payment = advance ? { type: 'partial', method: 'cash', amount: advance } : { type: 'none' };
    const res = await (await staff()).post(`${API}/admin/bookings`).send({
      slotId: (await slotAt(hour)).id, customer: { name: 'No Show Tester', phone: phoneOf(n), email: `t${n}${DOMAIN}` }, payment,
    }).expect(201);
    return res.body.data as { id: string; bookingNumber: string; customer: { id: string } };
  };
  /** A signed-in portal checkout at `hour` on d1 (cash, bKash and Nagad need a signed-in customer). */
  const checkout = async (hour: number, n: number, extra: object) => {
    const customer = await signInCustomer(app, phoneOf(n));
    const res = await customer.post(`${API}/checkout`).send({
      groundId, date: d1, hour, customerName: 'No Show Tester', customerEmail: `t${n}${DOMAIN}`, customerPhone: phoneOf(n), ...extra,
    }).expect(201);
    return res.body.data.bookingId as string;
  };
  const moveSlot = async (bookingId: string, date: string, startHour?: number) => {
    const { slotId } = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    await prisma.slot.update({ where: { id: slotId }, data: { date: toDbDate(date), ...(startHour !== undefined && { startHour }) } });
  };
  const noShow = async (id: string, status: number, body: object = {}) =>
    (await staff()).post(`${API}/admin/bookings/${id}/no-show`).send(body).expect(status);
  const dueIds = async () =>
    ((await (await staff()).get(`${API}/admin/bookings`).query({ due: 'any', groundId, limit: 100 }).expect(200)).body.data.data as { id: string }[])
      .map((b) => b.id);
  const customerDue = async (customerId: string) =>
    (await (await staff()).get(`${API}/admin/customers/${customerId}`).expect(200)).body.data.dueAmount as number;
  /** The Due column of this booking's row in the bookings CSV. */
  const csvDue = async (bookingNumber: string) => {
    const res = await (await staff()).get(`${API}/admin/reports/export`)
      .query({ type: 'bookings', from: yesterday, to: yesterday }).buffer(true).expect(200);
    return res.text.split('\r\n').find((line) => line.startsWith(`${bookingNumber},`))!.split(',')[11];
  };

  describe('a staff booking with an advance of 400 of 1000', () => {
    let booking: Awaited<ReturnType<typeof staffBooking>>;

    it('no-show writes off the due, keeps the advance and logs the event; the slot stays booked', async () => {
      booking = await staffBooking(6, 1, 400);
      await moveSlot(booking.id, yesterday);
      const before = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      const res = await noShow(booking.id, 200, { reason: 'Team never came' });
      expect(res.body.data).toMatchObject({ status: 'no_show', due: 0, paid: 400, paymentStatus: 'partial' });
      const detail = (await (await staff()).get(`${API}/admin/bookings/${booking.id}`).expect(200)).body.data;
      expect(detail.events.find((e: { type: string }) => e.type === 'no_show'))
        .toMatchObject({ detail: 'No-show: 600 due written off: Team never came', user: { name: 'Manager' } });
      const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id }, include: { slot: true, payments: true } });
      expect(after).toMatchObject({ liveSlotId: before.liveSlotId, slot: { status: 'booked' } });
      expect(after.payments).toEqual([expect.objectContaining({ amount: 400, status: 'succeeded' })]);
    });

    it('is not owed anywhere: no due filter, no customer due, 0 in the CSV', async () => {
      expect(await dueIds()).not.toContain(booking.id);
      expect(await customerDue(booking.customer.id)).toBe(0);
      expect(await csvDue(booking.bookingNumber)).toBe('0.00');
    });

    it('refuses collecting a payment and cancelling, and a second no-show', async () => {
      const agent = await staff();
      const pay = await agent.post(`${API}/admin/bookings/${booking.id}/payments`).send({ amount: 100, method: 'cash' }).expect(409);
      expect(pay.body.code).toBe('BOOKING_NO_SHOW');
      expect((await agent.post(`${API}/admin/bookings/${booking.id}/cancel`).send({ refund: true }).expect(409)).body.code).toBe('BOOKING_COMPLETED');
      expect((await noShow(booking.id, 409)).body.code).toBe('ALREADY_NO_SHOW');
    });

    it('undo brings the due back, as completed because the slot has ended', async () => {
      const res = await (await staff()).post(`${API}/admin/bookings/${booking.id}/undo-no-show`).expect(200);
      expect(res.body.data).toMatchObject({ status: 'completed', due: 600, paid: 400, paymentStatus: 'partial' });
      expect(await dueIds()).toContain(booking.id);
      expect(await customerDue(booking.customer.id)).toBe(600);
      expect(await csvDue(booking.bookingNumber)).toBe('6.00');
      const detail = (await (await staff()).get(`${API}/admin/bookings/${booking.id}`).expect(200)).body.data;
      expect(detail.events[0]).toMatchObject({ type: 'completed', detail: 'No-show undone' });
      const again = await (await staff()).post(`${API}/admin/bookings/${booking.id}/undo-no-show`).expect(409);
      expect(again.body.code).toBe('NOT_NO_SHOW');
    });
  });

  describe('refusals', () => {
    it('a slot that has not started: 409 SLOT_NOT_STARTED', async () => {
      const { id } = await staffBooking(7, 2, 400);
      expect((await noShow(id, 409)).body.code).toBe('SLOT_NOT_STARTED');
      expect(await prisma.booking.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'confirmed' });
    });

    it('a cancelled booking: 409 BOOKING_ALREADY_CANCELLED', async () => {
      const { id } = await staffBooking(8, 3);
      await (await staff()).post(`${API}/admin/bookings/${id}/cancel`).send({ refund: false, notifyCustomer: false }).expect(200);
      await moveSlot(id, yesterday);
      expect((await noShow(id, 409)).body.code).toBe('BOOKING_ALREADY_CANCELLED');
    });

    it('a bKash payment under review: 409 VERIFY_OR_REJECT', async () => {
      await prisma.slotSettings.upsert({ where: { id: 1 }, create: { id: 1, bkashNumber: '+8801700000060' }, update: { bkashNumber: '+8801700000060' } });
      const reference = `N${randomBytes(5).toString('hex').toUpperCase()}`;
      const id = await checkout(9, 4, { paymentMethod: 'bkash', reference, payerNumber: '01811000060' });
      await moveSlot(id, yesterday);
      expect((await noShow(id, 409)).body.code).toBe('VERIFY_OR_REJECT');
      expect(await prisma.booking.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'pending' });
    });
  });

  it('an ended pending cash booking needs an outcome until it is marked no-show', async () => {
    const id = await checkout(10, 5, { paymentMethod: 'cash' });
    // The most recently ended slot, so it is inside the card's capped list even with other files' bookings.
    await (hourNow >= 1 ? moveSlot(id, now.date, hourNow - 1) : moveSlot(id, yesterday, 23));
    const attention = async () => (await (await staff()).get(`${API}/admin/dashboard/attention`).expect(200)).body.data.needsOutcome;
    // Portal bookings add the service fee: all of it is due.
    const { total } = await prisma.booking.findUniqueOrThrow({ where: { id } });
    const before = await attention();
    expect(before.count).toBeGreaterThanOrEqual(1);
    expect(before.bookings.find((b: { id: string }) => b.id === id)).toMatchObject({ payAtVenue: true, total, due: total, paid: 0, walletPayment: null });

    const res = await noShow(id, 200);
    expect(res.body.data).toMatchObject({ status: 'no_show', due: 0, paymentStatus: 'unpaid' });
    const detail = (await (await staff()).get(`${API}/admin/bookings/${id}`).expect(200)).body.data;
    expect(detail.events.find((e: { type: string }) => e.type === 'no_show').detail).toBe(`No-show: ${total} due written off`);
    expect((await attention()).bookings.map((b: { id: string }) => b.id)).not.toContain(id);
  });

  it('counts.no_show counts this ground\'s no-shows', async () => {
    const expected = await prisma.booking.count({ where: { groundId, status: 'no_show', deletedAt: null } });
    expect(expected).toBeGreaterThanOrEqual(1);
    const res = await (await staff()).get(`${API}/admin/bookings`).query({ groundId }).expect(200);
    expect(res.body.data.counts.no_show).toBe(expected);
    const listed = await (await staff()).get(`${API}/admin/bookings`).query({ groundId, status: 'no_show' }).expect(200);
    expect(listed.body.data.total).toBe(expected);
  });
});
