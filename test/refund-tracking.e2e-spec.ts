import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { hashPassword } from './../src/auth/password.js';
import { bookingToken } from './../src/bookings/booking-rules.js';
import { EmailService } from './../src/email/email.service.js';
import { StripeService } from './../src/payments/stripe.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { addDays, toDbDate, venueNow } from './../src/slots/venue-time.js';
import { signInCustomer } from './sign-in-customer.js';

const API = '/api/v1';
const DOMAIN = '@refund-tracking.test';
const PREFIX = 'E2E Refund Tracking';
/** Every customer phone in this file starts with this, for cleanup. */
const PHONE = '+88017990120';
const password = 'e2e-password-123';
const manager = { email: `manager${DOMAIN}`, password };

const now = venueNow();
const d1 = addDays(now.date, 2);
const trx = () => `F${randomBytes(5).toString('hex').toUpperCase()}`;

const stripe = {
  createCheckoutSession: vi.fn(
    async ({ bookingId }: { bookingId: string }) => ({
      id: `cs_${bookingId}`,
      url: `https://stripe.test/${bookingId}`,
    }),
  ),
  openSessionUrl: vi.fn(async () => null),
  expireSession: vi.fn(async () => undefined),
  refund: vi.fn(async (intentId: string) => `re_${intentId}`),
  cardLast4: vi.fn(async () => '4242'),
  parseWebhook: vi.fn(),
};
const email = {
  send: vi.fn(async (_m: { to: string; subject: string }) => true),
};

describe('Refund tracking for bKash / Nagad (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let groundId: string;

  const cleanup = async () => {
    const ids = (
      await prisma.ground.findMany({
        where: { name: { startsWith: PREFIX } },
        select: { id: true },
      })
    ).map((g) => g.id);
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
        {
          email: manager.email,
          name: 'Refund Manager',
          role: 'manager',
          passwordHash,
        },
      ],
    });
    groundId = (
      await prisma.ground.create({
        data: {
          name: `${PREFIX} Main`,
          sport: 'football',
          hourlyPrice: 1000,
          openingHour: 6,
          closingHour: 22,
        },
      })
    ).id;
    await prisma.slot.createMany({
      data: Array.from({ length: 16 }, (_, i) => ({
        groundId,
        date: toDbDate(d1),
        startHour: 6 + i,
        price: 1000,
      })),
    });
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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

  const staff = async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post(`${API}/admin/auth/login`).send(manager).expect(200);
    return agent;
  };
  const payments = (id: string) =>
    prisma.payment.findMany({
      where: { bookingId: id },
      orderBy: { createdAt: 'asc' },
    });
  /** A portal bKash booking at `hour`, verified by staff and then cancelled with a refund (so a refund is due). */
  const refundedWalletBooking = async (
    hour: number,
    method: 'bkash' | 'nagad' = 'bkash',
  ) => {
    await prisma.slotSettings.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        bkashNumber: '+8801700000120',
        nagadNumber: '+8801700000121',
      },
      update: { bkashNumber: '+8801700000120', nagadNumber: '+8801700000121' },
    });
    const phone = `017990120${String(hour).padStart(2, '0')}`;
    const customer = await signInCustomer(app, phone);
    const res = await customer
      .post(`${API}/checkout`)
      .send({
        groundId,
        date: d1,
        hour,
        customerName: 'Tania Akter',
        customerEmail: 'tania@refund-tracking.test',
        customerPhone: phone,
        paymentMethod: method,
        reference: trx(),
        payerNumber: '01811000120',
      })
      .expect(201);
    const id = res.body.data.bookingId as string;
    const agent = await staff();
    await agent
      .post(`${API}/admin/bookings/${id}/confirm`)
      .send({ notifyCustomer: false })
      .expect(200);
    await agent
      .post(`${API}/admin/bookings/${id}/cancel`)
      .send({ refund: true, notifyCustomer: false })
      .expect(200);
    return { id, agent };
  };

  it('a refunded bKash booking shows the refund as due, in the detail, the list and the dashboard card', async () => {
    const { id, agent } = await refundedWalletBooking(6);
    const detail = (await agent.get(`${API}/admin/bookings/${id}`).expect(200))
      .body.data;
    expect(detail.refund).toEqual({
      amount: 6000,
      method: 'bkash',
      payerNumber: '+8801811000120',
      sentAt: null,
      sentBy: null,
      note: null,
    });

    const due = await agent
      .get(`${API}/admin/bookings`)
      .query({ refundDue: 'true', groundId })
      .expect(200);
    expect(due.body.data.data.map((b: { id: string }) => b.id)).toContain(id);
    expect(
      due.body.data.data.find((b: { id: string }) => b.id === id).refund,
    ).toMatchObject({ sentAt: null });
    await agent
      .get(`${API}/admin/bookings`)
      .query({ refundDue: 'false' })
      .expect(400);

    const attention = (
      await agent.get(`${API}/admin/dashboard/attention`).expect(200)
    ).body.data;
    expect(attention.refundDue.count).toBeGreaterThanOrEqual(1);
  });

  it('refund-sent records who sent it and the note, drops it from the due list, and a second click is 409 NO_REFUND_DUE', async () => {
    const { id, agent } = await refundedWalletBooking(7, 'nagad');
    const before = await payments(id);
    const res = await agent
      .post(`${API}/admin/bookings/${id}/refund-sent`)
      .send({ note: '  TrxID 8XK2  ' })
      .expect(200);
    expect(res.body.data.refund).toMatchObject({
      amount: 6000,
      method: 'nagad',
      sentAt: expect.any(String),
      sentBy: 'Refund Manager',
      note: 'TrxID 8XK2',
    });
    const [sent] = await payments(id);
    expect(sent).toMatchObject({
      status: 'refunded',
      refundSentAt: expect.any(Date),
      refundNote: 'TrxID 8XK2',
    });
    // Revenue dating is untouched: refundedAt and receivedAt stay as the cancel left them.
    expect(sent!.refundedAt).toEqual(before[0]!.refundedAt);
    expect(sent!.receivedAt).toEqual(before[0]!.receivedAt);

    const detail = (await agent.get(`${API}/admin/bookings/${id}`).expect(200))
      .body.data;
    expect(detail.events[0]).toMatchObject({
      type: 'refunded',
      detail: 'Refund of 6000 sent back by Nagad: TrxID 8XK2',
    });
    const due = await agent
      .get(`${API}/admin/bookings`)
      .query({ refundDue: 'true', groundId })
      .expect(200);
    expect(due.body.data.data.map((b: { id: string }) => b.id)).not.toContain(
      id,
    );

    const again = await agent
      .post(`${API}/admin/bookings/${id}/refund-sent`)
      .send({})
      .expect(409);
    expect(again.body.code).toBe('NO_REFUND_DUE');
    expect((await payments(id))[0]!.refundSentAt).toEqual(sent!.refundSentAt);
  });

  it('is 409 NO_REFUND_DUE for a booking with nothing to send back, 404 for an unknown one, 400 for a long note', async () => {
    const agent = await staff();
    const phone = '01799012099';
    const cash = await (
      await signInCustomer(app, phone)
    )
      .post(`${API}/checkout`)
      .send({
        groundId,
        date: d1,
        hour: 20,
        customerName: 'Tania Akter',
        customerEmail: 'tania@refund-tracking.test',
        customerPhone: phone,
        paymentMethod: 'cash',
      })
      .expect(201);
    const id = cash.body.data.bookingId as string;
    expect(
      (
        await agent
          .post(`${API}/admin/bookings/${id}/refund-sent`)
          .send({})
          .expect(409)
      ).body.code,
    ).toBe('NO_REFUND_DUE');
    expect(
      (
        await agent
          .post(`${API}/admin/bookings/${id}/refund-sent`)
          .send({ note: 'x'.repeat(201) })
          .expect(400)
      ).body.code,
    ).toBe('VALIDATION_FAILED');
    const missing = await agent
      .post(
        `${API}/admin/bookings/6f1c2a8e-0b7d-4c3e-9a51-2d4f8e6b7c10/refund-sent`,
      )
      .send({})
      .expect(404);
    expect(missing.body.code).toBe('BOOKING_NOT_FOUND');
    await request(app.getHttpServer())
      .post(`${API}/admin/bookings/${id}/refund-sent`)
      .send({})
      .expect(401);
  });

  it('lists refunds with search, method filters and stable pagination, then moves a sent refund into recorded history', async () => {
    const { id, agent } = await refundedWalletBooking(9);
    const other = await refundedWalletBooking(10, 'nagad');
    await prisma.booking.update({
      where: { id },
      data: { bookingNumber: `RF-SEARCH-1-${trx()}` },
    });
    const detail = (await agent.get(`${API}/admin/bookings/${id}`).expect(200))
      .body.data;
    const all = (
      await agent
        .get(`${API}/admin/bookings/refunds`)
        .query({ groundId })
        .expect(200)
    ).body.data;
    expect(all.data.map((b: { id: string }) => b.id)).toEqual(
      expect.arrayContaining([id, other.id]),
    );
    expect(
      all.data.find((b: { id: string }) => b.id === id).refundSummary,
    ).toMatchObject({
      amount: 6000,
      dueAmount: 6000,
      methods: ['bkash'],
      status: 'due',
      refundedAt: expect.any(String),
    });

    const search = (
      await agent
        .get(`${API}/admin/bookings/refunds`)
        .query({ groundId, status: 'due', search: detail.bookingNumber })
        .expect(200)
    ).body.data;
    expect(search.total).toBe(1);
    expect(search.data[0].id).toBe(id);
    const phone = (
      await agent
        .get(`${API}/admin/bookings/refunds`)
        .query({ groundId, search: '01799 0120' })
        .expect(200)
    ).body.data;
    expect(phone.data.map((b: { id: string }) => b.id)).toContain(id);
    const bkash = (
      await agent
        .get(`${API}/admin/bookings/refunds`)
        .query({ groundId, method: 'bkash' })
        .expect(200)
    ).body.data;
    expect(bkash.data.map((b: { id: string }) => b.id)).toContain(id);
    expect(bkash.data.map((b: { id: string }) => b.id)).not.toContain(other.id);
    const page1 = (
      await agent
        .get(`${API}/admin/bookings/refunds`)
        .query({ groundId, limit: 1 })
        .expect(200)
    ).body.data;
    const page2 = (
      await agent
        .get(`${API}/admin/bookings/refunds`)
        .query({ groundId, limit: 1, page: 2 })
        .expect(200)
    ).body.data;
    expect(page1.data).toHaveLength(1);
    expect(page2.data).toHaveLength(1);
    expect(page1.total).toBe(all.total);
    expect(page1.data[0].id).not.toBe(page2.data[0].id);

    await agent
      .post(`${API}/admin/bookings/${id}/refund-sent`)
      .send({ note: 'Refund list test' })
      .expect(200);
    const due = (
      await agent
        .get(`${API}/admin/bookings/refunds`)
        .query({ groundId, status: 'due', search: detail.bookingNumber })
        .expect(200)
    ).body.data;
    expect(due.total).toBe(0);
    const recorded = (
      await agent
        .get(`${API}/admin/bookings/refunds`)
        .query({ groundId, status: 'recorded', search: detail.bookingNumber })
        .expect(200)
    ).body.data;
    expect(recorded.total).toBe(1);
    expect(recorded.data[0].refundSummary).toMatchObject({
      amount: 6000,
      dueAmount: 0,
      status: 'recorded',
    });
  });

  it('includes card, cash and bank refunds but excludes deleted bookings, deleted payments and unrefunded money', async () => {
    const agent = await staff();
    const customer = await prisma.customer.create({
      data: { name: 'Refund History', phone: `${PHONE}98` },
    });
    const slot = await prisma.slot.findFirstOrThrow({
      where: { groundId, date: toDbDate(d1), startHour: 21 },
    });
    const prefix = `RF-LIST-${trx()}`;
    const cases = [
      { name: 'card', method: 'card', status: 'refunded' },
      { name: 'cash', method: 'cash', status: 'refunded' },
      { name: 'bank', method: 'bank_transfer', status: 'refunded' },
      { name: 'pending', method: 'bkash', status: 'pending' },
      { name: 'failed', method: 'card', status: 'failed' },
      {
        name: 'deleted-payment',
        method: 'card',
        status: 'refunded',
        paymentDeleted: true,
      },
      {
        name: 'deleted-booking',
        method: 'cash',
        status: 'refunded',
        bookingDeleted: true,
      },
    ] as const;
    const created = [];
    for (const item of cases) {
      created.push(
        await prisma.booking.create({
          data: {
            bookingNumber: `${prefix}-${item.name}`,
            source: 'staff',
            groundId,
            slotId: slot.id,
            customerId: customer.id,
            contactName: customer.name,
            contactPhone: customer.phone!,
            status: 'cancelled',
            paymentStatus: item.status === 'refunded' ? 'refunded' : 'unpaid',
            amount: 1000,
            total: 1000,
            deletedAt: 'bookingDeleted' in item ? new Date() : null,
            payments: {
              create: {
                method: item.method,
                status: item.status,
                amount: 1000,
                currency: 'bdt',
                refundedAt: item.status === 'refunded' ? new Date() : null,
                deletedAt: 'paymentDeleted' in item ? new Date() : null,
              },
            },
          },
        }),
      );
    }
    const all = (
      await agent
        .get(`${API}/admin/bookings/refunds`)
        .query({ groundId, search: prefix })
        .expect(200)
    ).body.data;
    expect(all.total).toBe(3);
    expect(all.data.map((b: { id: string }) => b.id).sort()).toEqual(
      created
        .slice(0, 3)
        .map((b) => b.id)
        .sort(),
    );
    expect(
      all.data.map(
        (b: { refundSummary: { amount: number; status: string } }) =>
          b.refundSummary,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ amount: 1000, status: 'recorded' }),
      ]),
    );
    const cash = (
      await agent
        .get(`${API}/admin/bookings/refunds`)
        .query({ groundId, search: prefix, method: 'cash' })
        .expect(200)
    ).body.data;
    expect(cash.total).toBe(1);
    expect(cash.data[0].id).toBe(created[1]!.id);
    expect(
      (
        await agent
          .get(`${API}/admin/bookings/refunds`)
          .query({ groundId, search: prefix, status: 'due' })
          .expect(200)
      ).body.data.total,
    ).toBe(0);
  });

  it('guards the refund list and rejects invalid filters', async () => {
    await request(app.getHttpServer())
      .get(`${API}/admin/bookings/refunds`)
      .expect(401);
    const agent = await staff();
    for (const query of [
      { status: 'sent' },
      { method: 'upi' },
      { groundId: 'bad' },
      { page: 0 },
      { limit: 101 },
    ]) {
      await agent.get(`${API}/admin/bookings/refunds`).query(query).expect(400);
    }
  });

  it('the customer link does not expose the refund', async () => {
    const { id } = await refundedWalletBooking(8);
    const res = await request(app.getHttpServer())
      .get(`${API}/bookings/${id}`)
      .query({ token: bookingToken(id) })
      .expect(200);
    expect(res.body.data).not.toHaveProperty('refund');
  });
});
