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

const API = '/api/v1';
const DOMAIN = '@wallet-review.test';
const PREFIX = 'E2E Wallet Review';
/** Every customer phone in this file starts with this, for cleanup. */
const PHONE = '+88017990041';
const password = 'e2e-password-123';
const manager = { email: `manager${DOMAIN}`, password };

const now = venueNow();
const d1 = addDays(now.date, 2);
const trx = () => `R${randomBytes(5).toString('hex').toUpperCase()}`;

const stripe = {
  createCheckoutSession: vi.fn(async ({ bookingId }: { bookingId: string }) => ({ id: `cs_${bookingId}`, url: `https://stripe.test/${bookingId}` })),
  openSessionUrl: vi.fn(async () => null), expireSession: vi.fn(async () => undefined),
  refund: vi.fn(async (intentId: string) => `re_${intentId}`), cardLast4: vi.fn(async () => '4242'), parseWebhook: vi.fn(),
};
const email = { send: vi.fn(async (_m: { to: string; subject: string }) => true) };

describe('bKash / Nagad under review (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let groundId: string;

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
    const passwordHash = await hashPassword(password);
    // The admin receives staff emails when the Notifications page lists no recipients.
    await prisma.user.createMany({
      data: [
        { email: manager.email, name: 'Manager', role: 'manager', passwordHash },
        { email: `admin${DOMAIN}`, name: 'Admin', role: 'admin', passwordHash },
      ],
    });
    groundId = (await prisma.ground.create({
      data: { name: `${PREFIX} Main`, sport: 'football', hourlyPrice: 1000, openingHour: 6, closingHour: 22 },
    })).id;
    await prisma.slot.createMany({ data: Array.from({ length: 16 }, (_, i) => ({ groundId, date: toDbDate(d1), startHour: 6 + i, price: 1000 })) });
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
  const slotOf = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } }).then((b) => prisma.slot.findUniqueOrThrow({ where: { id: b.slotId } }));
  const booking = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id }, include: { payments: true } });
  const checkout = (hour: number, extra: object) => http().post(`${API}/checkout`).send({
    groundId, date: d1, hour, customerName: 'Tania Akter', customerEmail: 'tania@wallet-review.test', customerPhone: '01799004101', ...extra,
  });
  /** A portal bKash booking at `hour`, under review. */
  const walletBooking = async (hour: number, reference = trx()) => {
    await prisma.slotSettings.upsert({ where: { id: 1 }, create: { id: 1, bkashNumber: '+8801700000041' }, update: { bkashNumber: '+8801700000041' } });
    const res = await checkout(hour, { paymentMethod: 'bkash', reference, payerNumber: '01811000041' }).expect(201);
    return res.body.data.bookingId as string;
  };
  /** This file's ground only: other files verify bKash payments in parallel. */
  const revenue = async (date: string) => {
    const res = await (await staff()).get(`${API}/admin/reports/grounds`).query({ from: date, to: date }).expect(200);
    return (res.body.data.find((g: { groundId: string }) => g.groundId === groundId)?.revenue ?? 0) as number;
  };

  describe('cancel request', () => {
    let id: string;

    it('is recorded once, logged, emailed to staff and shown to staff', async () => {
      id = await walletBooking(6);
      const token = bookingToken(id);
      email.send.mockClear();
      const res = await http().post(`${API}/bookings/${id}/cancel-request`).query({ token }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'pending', cancelRequested: true, canRequestCancel: false, canCancel: false });
      expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringContaining('Cancellation requested') }));
      expect((await http().post(`${API}/bookings/${id}/cancel-request`).query({ token }).expect(409)).body.code).toBe('CANCEL_ALREADY_REQUESTED');

      const agent = await staff();
      const detail = (await agent.get(`${API}/admin/bookings/${id}`).expect(200)).body.data;
      expect(detail.cancelRequestedAt).toEqual(expect.any(String));
      expect(detail.events.map((e: { type: string }) => e.type)).toContain('cancel_requested');
      const queue = await agent.get(`${API}/admin/bookings`).query({ status: 'pending', groundId }).expect(200);
      expect(queue.body.data.data.find((b: { id: string }) => b.id === id).cancelRequestedAt).toEqual(expect.any(String));
    });

    it('staff cannot refund before verifying; verify, then cancel with refund (by hand, no Stripe)', async () => {
      const agent = await staff();
      expect((await agent.post(`${API}/admin/bookings/${id}/cancel`).send({ refund: true }).expect(409)).body.code).toBe('VERIFY_OR_REJECT');
      await agent.post(`${API}/admin/bookings/${id}/confirm`).send({ notifyCustomer: false }).expect(200);
      stripe.refund.mockClear();
      email.send.mockClear();
      const res = await agent.post(`${API}/admin/bookings/${id}/cancel`).send({ refund: true }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'cancelled', paymentStatus: 'refunded' });
      expect(stripe.refund).not.toHaveBeenCalled();
      expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'tania@wallet-review.test', subject: expect.stringContaining('cancelled') }));
    });

    it('is refused inside the cutoff and when nothing is under review', async () => {
      const late = await walletBooking(7);
      const hour = Math.min(Math.floor(now.minutes / 60) + 1, 23);
      await prisma.slot.update({ where: { id: (await slotOf(late)).id }, data: { date: toDbDate(now.date), startHour: hour } });
      const inside = await http().post(`${API}/bookings/${late}/cancel-request`).query({ token: bookingToken(late) }).expect(400);
      expect(inside.body.code).toBe('CANCELLATION_WINDOW_PASSED');

      const cash = (await checkout(8, { paymentMethod: 'cash' }).expect(201)).body.data.bookingId;
      const res = await http().post(`${API}/bookings/${cash}/cancel-request`).query({ token: bookingToken(cash) }).expect(409);
      expect(res.body.code).toBe('NOT_UNDER_REVIEW');
      // After verification the normal cancel works again.
      const verified = await walletBooking(9);
      await (await staff()).post(`${API}/admin/bookings/${verified}/confirm`).send({ notifyCustomer: false }).expect(200);
      await http().post(`${API}/bookings/${verified}/cancel`).query({ token: bookingToken(verified) }).expect(200);
      expect((await booking(verified)).payments[0]).toMatchObject({ status: 'refunded' });
    });
  });

  describe('money while under review', () => {
    it('is not owed: no dues, no customer due amount, no collecting', async () => {
      const id = await walletBooking(10);
      const agent = await staff();
      const due = await agent.get(`${API}/admin/bookings`).query({ due: 'any', groundId }).expect(200);
      expect(due.body.data.data.map((b: { id: string }) => b.id)).not.toContain(id);
      const { customerId } = await booking(id);
      const customer = (await agent.get(`${API}/admin/customers/${customerId}`).expect(200)).body.data;
      expect(customer.duePayments.map((d: { bookingId: string }) => d.bookingId)).not.toContain(id);
      const collect = await agent.post(`${API}/admin/bookings/${id}/payments`).send({ amount: 6000, method: 'cash' }).expect(409);
      expect(collect.body.code).toBe('PAYMENT_UNDER_REVIEW');
    });

    it('verify is refused when other payments already cover the total', async () => {
      const id = await walletBooking(11);
      await prisma.payment.create({ data: { bookingId: id, method: 'cash', amount: 6000, currency: 'bdt', status: 'succeeded', receivedAt: new Date() } });
      const res = await (await staff()).post(`${API}/admin/bookings/${id}/confirm`).send({}).expect(409);
      expect(res.body.code).toBe('WALLET_PAYMENT_EXCEEDS_DUE');
      expect((await booking(id)).payments.find((p) => p.method === 'bkash')).toMatchObject({ status: 'pending' });
    });

    it('counts on the day it is verified, not the day it was sent', async () => {
      const id = await walletBooking(12);
      const sent = addDays(now.date, -3);
      await prisma.payment.updateMany({ where: { bookingId: id }, data: { createdAt: new Date(`${sent}T06:00:00Z`) } });
      const [todayBefore, sentBefore] = [await revenue(now.date), await revenue(sent)];
      await (await staff()).post(`${API}/admin/bookings/${id}/confirm`).send({ notifyCustomer: false }).expect(200);
      expect((await revenue(now.date)) - todayBefore).toBe(6000);
      expect(await revenue(sent)).toBe(sentBefore);
      expect((await booking(id)).payments[0]!.receivedAt).toEqual(expect.any(Date));
    });
  });

  describe('TrxID reuse', () => {
    it('blocked while pending or verified; free again once rejected', async () => {
      const reference = trx();
      const first = await walletBooking(13, reference);
      expect((await checkout(14, { paymentMethod: 'bkash', reference, payerNumber: '01811000041' }).expect(409)).body.code).toBe('REFERENCE_ALREADY_USED');
      await (await staff()).post(`${API}/admin/bookings/${first}/cancel`).send({ refund: false, rejectWalletPayment: true }).expect(200);
      const second = await walletBooking(14, reference);
      await (await staff()).post(`${API}/admin/bookings/${second}/confirm`).send({ notifyCustomer: false }).expect(200);
      expect((await checkout(15, { paymentMethod: 'bkash', reference, payerNumber: '01811000041' }).expect(409)).body.code).toBe('REFERENCE_ALREADY_USED');
    });
  });

  describe('edges', () => {
    it('staff can reject an unverified payment after the slot ended; other cancels still cannot', async () => {
      const id = await walletBooking(15);
      const yesterday = addDays(now.date, -1);
      await prisma.slot.update({ where: { id: (await slotOf(id)).id }, data: { date: toDbDate(yesterday) } });
      const agent = await staff();
      for (const refund of [true, false]) {
        expect((await agent.post(`${API}/admin/bookings/${id}/cancel`).send({ refund }).expect(409)).body.code).toBe('VERIFY_OR_REJECT');
      }
      const res = await agent.post(`${API}/admin/bookings/${id}/cancel`).send({ refund: false, rejectWalletPayment: true, reason: 'Not received' }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'cancelled', paymentStatus: 'failed' });
      const detail = (await agent.get(`${API}/admin/bookings/${id}`).expect(200)).body.data;
      expect(detail.events.find((e: { type: string }) => e.type === 'cancelled').detail).toMatch(/bKash payment \(TrxID R[0-9A-F]+\) rejected/);

      const cash = (await checkout(16, { paymentMethod: 'cash' }).expect(201)).body.data.bookingId;
      await prisma.slot.update({ where: { id: (await slotOf(cash)).id }, data: { date: toDbDate(yesterday) } });
      expect((await agent.post(`${API}/admin/bookings/${cash}/cancel`).send({ refund: false }).expect(409)).body.code).toBe('BOOKING_COMPLETED');
    });

    it('blocking the slot over a payment under review is refused (verify or reject first), and changes nothing', async () => {
      const id = await walletBooking(18);
      const slot = await slotOf(id);
      const agent = await staff();
      const res = await agent.post(`${API}/admin/slots/${slot.id}/block`).send({ reason: 'maintenance', cancelBooking: true }).expect(409);
      expect(res.body.code).toBe('VERIFY_OR_REJECT');
      expect(await booking(id)).toMatchObject({ status: 'pending', payments: [expect.objectContaining({ status: 'pending' })] });
      expect(await slotOf(id)).toMatchObject({ status: 'booked' });
      await agent.post(`${API}/admin/bookings/${id}/cancel`).send({ refund: false, rejectWalletPayment: true }).expect(200);
      await agent.post(`${API}/admin/slots/${slot.id}/block`).send({ reason: 'maintenance' }).expect(200);
    });

    it('refuses a TrxID that would be dropped', async () => {
      expect((await checkout(17, { paymentMethod: 'cash', reference: trx() }).expect(400)).body.code).toBe('VALIDATION_FAILED');
      const slot = await prisma.slot.findFirstOrThrow({ where: { groundId, status: 'available' } });
      const res = await (await staff()).post(`${API}/admin/bookings`).send({
        slotId: slot.id, customer: { name: 'Walk In', phone: '01799004102', email: 'w@wallet-review.test' },
        payment: { type: 'none', method: 'bkash', reference: trx() },
      }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });
  });
});
