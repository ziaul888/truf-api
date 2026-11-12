import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { hashPassword } from './../src/auth/password.js';
import { BookingJobs } from './../src/bookings/booking-jobs.js';
import { bookingToken } from './../src/bookings/booking-rules.js';
import { EmailService } from './../src/email/email.service.js';
import { StripeService } from './../src/payments/stripe.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { addDays, toDbDate, venueNow } from './../src/slots/venue-time.js';
import { signInCustomer } from './sign-in-customer.js';

const API = '/api/v1';
const LOGIN = `${API}/admin/auth/login`;
const SLOT_SETTINGS = `${API}/admin/settings/slots`;
const DOMAIN = '@wallets.test';
const PREFIX = 'E2E Wallets';
/** Every customer phone in this file starts with this, for cleanup. */
const PHONE = '+88017990040';
const password = 'e2e-password-123';
const admin = { email: `admin${DOMAIN}`, password };
const manager = { email: `manager${DOMAIN}`, password };
const BKASH = '+8801700000041';
const NAGAD = '+8801700000042';

const today = venueNow().date;
const d1 = addDays(today, 2);
const d2 = addDays(today, 3);

/** A fresh TrxID per call, so a second run never clashes with the first. */
const trx = () => `T${randomBytes(5).toString('hex').toUpperCase()}`;

const stripe = {
  createCheckoutSession: vi.fn(async ({ bookingId }: { bookingId: string }) => ({ id: `cs_${bookingId}`, url: `https://stripe.test/${bookingId}` })),
  openSessionUrl: vi.fn(async () => null), expireSession: vi.fn(async () => undefined),
  refund: vi.fn(async (intentId: string) => `re_${intentId}`), cardLast4: vi.fn(async () => '4242'), parseWebhook: vi.fn(),
};
const email = { send: vi.fn(async () => true) };

describe('bKash / Nagad payments (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let groundId: string;

  const cleanup = async () => {
    const grounds = await prisma.ground.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
    const ids = grounds.map((g) => g.id);
    await prisma.bookingEvent.deleteMany({ where: { booking: { groundId: { in: ids } } } });
    await prisma.payment.deleteMany({ where: { booking: { groundId: { in: ids } } } });
    await prisma.bookingSlot.deleteMany({ where: { booking: { groundId: { in: ids } } } });
    await prisma.booking.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { phone: { startsWith: PHONE } } });
    await prisma.slot.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.ground.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  };

  /** The settings row is shared (slots.e2e-spec deletes it): set the numbers right before each wallet checkout. */
  const setNumbers = (bkashNumber: string | null, nagadNumber: string | null) => prisma.slotSettings.upsert({
    where: { id: 1 }, create: { id: 1, bkashNumber, nagadNumber }, update: { bkashNumber, nagadNumber },
  });
  const walletsOn = () => setNumbers(BKASH, NAGAD);

  beforeAll(async () => {
    prisma = new PrismaService();
    await cleanup();
    const passwordHash = await hashPassword(password);
    await prisma.user.createMany({
      data: [
        { email: admin.email, name: 'Admin', role: 'admin', passwordHash },
        { email: manager.email, name: 'Manager', role: 'manager', passwordHash },
      ],
    });
    groundId = (await prisma.ground.create({
      data: { name: `${PREFIX} Main`, sport: 'football', hourlyPrice: 1000, openingHour: 8, closingHour: 12 },
    })).id;
    const slots = [d1, d2].flatMap((date) => [8, 9, 10, 11].map((startHour) => ({ groundId, date: toDbDate(date), startHour, price: 1000 })));
    await prisma.slot.createMany({ data: slots });
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeService).useValue(stripe)
      .overrideProvider(EmailService).useValue(email)
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterEach(() => app.close());

  afterAll(async () => {
    await cleanup();
    await prisma.slotSettings.updateMany({ data: { bkashNumber: null, nagadNumber: null } });
    await prisma.$disconnect();
  });

  async function signIn(creds: { email: string; password: string }) {
    const agent = request.agent(app.getHttpServer());
    await agent.post(LOGIN).send(creds).expect(200);
    return agent;
  }

  const http = () => request(app.getHttpServer());
  const slotAt = (date: string, startHour: number) =>
    prisma.slot.findUniqueOrThrow({ where: { groundId_date_startHour_startMinute: { groundId, date: toDbDate(date), startHour, startMinute: 0 } } });
  const booking = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id }, include: { payments: true } });
  /** bKash / Nagad need a signed-in customer: pass their agent as `client`. */
  const checkout = (
    date: string, hour: number, phoneSuffix: string, extra: object,
    client: ReturnType<typeof request.agent> | ReturnType<typeof http> = http(),
  ) => client.post(`${API}/checkout`).send({
    groundId, date, hour, customerName: 'Nusrat Jahan', customerEmail: 'nusrat@wallets.test', customerPhone: `0179900400${phoneSuffix}`, ...extra,
  });
  const walletCheckout = async (date: string, hour: number, method: 'bkash' | 'nagad', reference: string, status: number) => {
    await walletsOn();
    const customer = await signInCustomer(app, '01799004001');
    return checkout(date, hour, '1', { paymentMethod: method, reference, payerNumber: '01811000041' }, customer).expect(status);
  };
  /** Today's revenue on this file's ground (other files verify bKash payments in parallel) and venue-wide bKash. */
  const bkashToday = async () => {
    const agent = await signIn(manager);
    const grounds = await agent.get(`${API}/admin/reports/grounds`).query({ from: today, to: today }).expect(200);
    const summary = await agent.get(`${API}/admin/reports/summary`).query({ from: today, to: today }).expect(200);
    return { ground: grounds.body.data.find((g: { groundId: string }) => g.groundId === groundId)?.revenue ?? 0, bkash: summary.body.data.revenueByMethod.bkash };
  };

  describe('settings and options', () => {
    it('admins set the numbers ("" turns one off); managers cannot', async () => {
      await (await signIn(manager)).put(SLOT_SETTINGS).send({ bkashNumber: '01700000041' }).expect(403);
      const res = await (await signIn(admin)).put(SLOT_SETTINGS).send({ bkashNumber: '01700000041', nagadNumber: '' }).expect(200);
      expect(res.body.data).toMatchObject({ bkashNumber: BKASH, nagadNumber: null });
      const bad = await (await signIn(admin)).put(SLOT_SETTINGS).send({ nagadNumber: '12' }).expect(400);
      expect(bad.body.code).toBe('VALIDATION_FAILED');
    });

    it('lists only the wallets with a number, and refuses the other one', async () => {
      await setNumbers(BKASH, null);
      const res = await http().get(`${API}/checkout/options`).expect(200);
      expect(res.body.data.wallets).toEqual([{ method: 'bkash', number: BKASH }]);
      const status = await (await signIn(manager)).get(`${API}/admin/settings/payments/status`).expect(200);
      expect(status.body.data.methods).toMatchObject({ bkash: true, nagad: false });

      await setNumbers(BKASH, null);
      const refused = await checkout(d1, 8, '1', { paymentMethod: 'nagad', reference: trx(), payerNumber: '01811000041' }).expect(400);
      expect(refused.body.code).toBe('WALLET_NOT_AVAILABLE');
      expect(await slotAt(d1, 8)).toMatchObject({ status: 'available' });
    });

    it('requires a valid TrxID and sender number', async () => {
      await walletsOn();
      const bad = await checkout(d1, 8, '1', { paymentMethod: 'bkash', reference: 'AB-1', payerNumber: '01811000041' }).expect(400);
      expect(bad.body).toMatchObject({ code: 'VALIDATION_FAILED', details: [expect.objectContaining({ field: 'reference' })] });
      const missing = await checkout(d1, 8, '1', { paymentMethod: 'bkash' }).expect(400);
      expect(missing.body.details.map((d: { field: string }) => d.field).sort()).toEqual(['payerNumber', 'reference']);
      expect(await slotAt(d1, 8)).toMatchObject({ status: 'available' });
    });
  });

  describe('a portal bKash booking', () => {
    let bookingId: string;
    let reference: string;

    it('books the slot, pending, with a pending payment for the total', async () => {
      reference = trx();
      const res = await walletCheckout(d1, 9, 'bkash', `  ${reference.toLowerCase()} `, 201);
      bookingId = res.body.data.bookingId;
      expect(res.body.data).toMatchObject({ paymentMethod: 'bkash', checkoutUrl: null, confirmationUrl: expect.stringContaining(`/confirmation/${bookingId}?token=`) });
      expect(stripe.createCheckoutSession).not.toHaveBeenCalledWith(expect.objectContaining({ bookingId }));
      expect(await slotAt(d1, 9)).toMatchObject({ status: 'booked', heldUntil: null });
      const b = await booking(bookingId);
      expect(b).toMatchObject({ status: 'pending', paymentStatus: 'unpaid', source: 'portal', payAtVenue: false, total: 6000, stripeCheckoutSessionId: null });
      expect(b.payments).toEqual([expect.objectContaining({ method: 'bkash', status: 'pending', amount: 6000, reference, payerNumber: '+8801811000041' })]);
      expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringContaining('received'), text: expect.stringContaining('verify') }));
    });

    it('the customer sees it awaiting verification, with no "Pay now"', async () => {
      const token = bookingToken(bookingId);
      const res = await http().get(`${API}/bookings/${bookingId}`).query({ token }).expect(200);
      expect(res.body.data).toMatchObject({
        status: 'pending', canPay: false, canCancel: false, canRequestCancel: true, cancelRequested: false, walletPayment: { method: 'bkash', amount: 6000, reference, status: 'pending' },
      });
      expect(res.body.data.walletPayment).not.toHaveProperty('payerNumber');
      expect((await http().post(`${API}/bookings/${bookingId}/pay`).query({ token }).expect(409)).body.code).toBe('PAYMENT_UNDER_REVIEW');
    });

    it('the same TrxID is refused on the portal (same method) and leaves the slot free', async () => {
      const res = await walletCheckout(d1, 10, 'bkash', reference, 409);
      expect(res.body.code).toBe('REFERENCE_ALREADY_USED');
      expect(await slotAt(d1, 10)).toMatchObject({ status: 'available' });
    });

    it('the same TrxID is refused on the staff paths too', async () => {
      const agent = await signIn(manager);
      const { id: slotId } = await slotAt(d1, 10);
      const created = await agent.post(`${API}/admin/bookings`).send({
        slotId, customer: { name: 'Walk In', phone: '01799004002', email: 'walk@wallets.test' },
        payment: { type: 'full', method: 'bkash', reference },
      }).expect(409);
      expect(created.body.code).toBe('REFERENCE_ALREADY_USED');
      expect(await slotAt(d1, 10)).toMatchObject({ status: 'available' });
    });

    it('shows in the to-confirm list and as "to verify", not in dues, and not as a card checkout', async () => {
      const agent = await signIn(manager);
      const card = (await checkout(d2, 8, '3', { paymentMethod: 'card' }).expect(201)).body.data.bookingId;
      const queue = await agent.get(`${API}/admin/bookings`).query({ status: 'pending', groundId }).expect(200);
      expect(queue.body.data.data.find((b: { id: string }) => b.id === bookingId)).toMatchObject({
        walletPayment: { method: 'bkash', reference, payerNumber: '+8801811000041', status: 'pending', amount: 6000 },
      });
      expect(queue.body.data.data.map((b: { id: string }) => b.id)).toContain(card);
      const due = await agent.get(`${API}/admin/bookings`).query({ due: 'any', groundId }).expect(200);
      const ids = due.body.data.data.map((b: { id: string }) => b.id);
      expect(ids).not.toContain(bookingId);
      expect(ids).not.toContain(card);
      expect((await agent.get(`${API}/admin/dashboard/attention`).expect(200)).body.data.toVerify.count).toBeGreaterThanOrEqual(1);
    });

    it('the hold sweep leaves it alone', async () => {
      await app.get(BookingJobs).releaseExpiredHolds();
      expect(await booking(bookingId)).toMatchObject({ status: 'pending', liveSlotId: (await slotAt(d1, 9)).id });
      expect(await slotAt(d1, 9)).toMatchObject({ status: 'booked' });
    });

    it('staff verify: payment received by them, booking confirmed and paid, counted under bKash', async () => {
      const before = await bkashToday();
      const agent = await signIn(manager);
      const res = await agent.post(`${API}/admin/bookings/${bookingId}/confirm`).send({ notifyCustomer: true }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'confirmed', paymentStatus: 'paid', paid: 6000, due: 0, walletPayment: { status: 'succeeded' } });
      const { id: managerId } = await prisma.user.findUniqueOrThrow({ where: { email: manager.email } });
      expect((await booking(bookingId)).payments[0]).toMatchObject({ status: 'succeeded', recordedById: managerId });
      const after = await bkashToday();
      expect([after.ground - before.ground, after.bkash >= 6000]).toEqual([6000, true]);
      expect((await agent.post(`${API}/admin/bookings/${bookingId}/confirm`).send({}).expect(409)).body.code).toBe('BOOKING_NOT_PENDING');

      const detail = await agent.get(`${API}/admin/bookings/${bookingId}`).expect(200);
      expect(detail.body.data.payments[0]).toMatchObject({ method: 'bkash', reference, payerNumber: '+8801811000041' });
    });

    it('cancelling after verify marks it refunded without Stripe', async () => {
      const agent = await signIn(admin);
      stripe.refund.mockClear();
      const res = await agent.post(`${API}/admin/bookings/${bookingId}/cancel`).send({ refund: true, notifyCustomer: false }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'cancelled', paymentStatus: 'refunded' });
      expect(stripe.refund).not.toHaveBeenCalled();
      expect((await booking(bookingId)).payments[0]).toMatchObject({ status: 'refunded', stripeRefundId: null });
    });
  });

  describe('before verification', () => {
    it('staff reject: the booking is cancelled, the payment fails and the slot is free', async () => {
      const { bookingId } = (await walletCheckout(d2, 9, 'nagad', trx(), 201)).body.data;
      const res = await (await signIn(manager)).post(`${API}/admin/bookings/${bookingId}/cancel`)
        .send({ reason: 'No such TrxID in our Nagad app', refund: false, rejectWalletPayment: true }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'cancelled', paymentStatus: 'failed', walletPayment: { method: 'nagad', status: 'failed' } });
      expect((await booking(bookingId)).payments[0]).toMatchObject({ status: 'failed', refundedAt: null });
      expect(await slotAt(d2, 9)).toMatchObject({ status: 'available' });
    });

    it('the customer cannot cancel directly; staff reject it and the slot is free', async () => {
      const { bookingId } = (await walletCheckout(d2, 10, 'bkash', trx(), 201)).body.data;
      const token = bookingToken(bookingId);
      expect((await http().get(`${API}/bookings/${bookingId}`).query({ token }).expect(200)).body.data).toMatchObject({ canCancel: false, canRequestCancel: true });
      expect((await http().post(`${API}/bookings/${bookingId}/cancel`).query({ token }).expect(409)).body.code).toBe('PAYMENT_UNDER_REVIEW');
      await (await signIn(manager)).post(`${API}/admin/bookings/${bookingId}/cancel`).send({ refund: false, rejectWalletPayment: true, notifyCustomer: false }).expect(200);
      expect((await booking(bookingId)).payments[0]).toMatchObject({ status: 'failed' });
      expect(await slotAt(d2, 10)).toMatchObject({ status: 'available' });
      const report = await (await signIn(manager)).get(`${API}/admin/reports/grounds`).query({ from: d2, to: d2 }).expect(200);
      expect(report.body.data.find((g: { groundId: string }) => g.groundId === groundId)).toMatchObject({ cancelled: 2 });
    });
  });

  describe('staff payments by bKash / Nagad', () => {
    it('records the TrxID, unique per method', async () => {
      const agent = await signIn(manager);
      const reference = trx();
      const { id: slotId } = await slotAt(d2, 11);
      const created = await agent.post(`${API}/admin/bookings`).send({
        slotId, customer: { name: 'Advance Payer', phone: '01799004005', email: 'adv@wallets.test' },
        payment: { type: 'partial', method: 'nagad', amount: 400, reference },
      }).expect(201);
      const id = created.body.data.id;
      expect(created.body.data).toMatchObject({ status: 'confirmed', paymentStatus: 'partial', walletPayment: null });
      expect((await booking(id)).payments[0]).toMatchObject({ method: 'nagad', reference, status: 'succeeded' });

      const dup = await agent.post(`${API}/admin/bookings/${id}/payments`).send({ amount: 600, method: 'nagad', reference }).expect(409);
      expect(dup.body.code).toBe('REFERENCE_ALREADY_USED');
      const cashRef = await agent.post(`${API}/admin/bookings/${id}/payments`).send({ amount: 600, method: 'cash', reference: trx() }).expect(400);
      expect(cashRef.body.code).toBe('VALIDATION_FAILED');
      // Unique per method: the same TrxID by bKash is a different transaction.
      const paid = await agent.post(`${API}/admin/bookings/${id}/payments`).send({ amount: 600, method: 'bkash', reference }).expect(201);
      expect(paid.body.data).toMatchObject({ paymentStatus: 'paid', due: 0 });
    });
  });

  it('revenue CSV keeps its columns and adds bKash and Nagad at the end', async () => {
    const res = await (await signIn(admin)).get(`${API}/admin/reports/export`)
      .query({ type: 'revenue', from: today, to: today, groupBy: 'day' }).buffer(true).expect(200);
    const lines = res.text.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toBe('Period start,Period end,Received,Refunds,Net revenue,Card,Cash,Bank transfer,Bookings,bKash,Nagad');
    expect(lines[1]!.split(',')).toHaveLength(11);
  });
});
