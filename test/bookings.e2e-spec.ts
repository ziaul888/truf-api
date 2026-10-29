import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { hashPassword } from './../src/auth/password.js';
import { BookingJobs } from './../src/bookings/booking-jobs.js';
import { bookingToken } from './../src/bookings/booking-rules.js';
import { AppError } from './../src/common/app-error.js';
import { EmailService } from './../src/email/email.service.js';
import { StripeService } from './../src/payments/stripe.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { addDays, toDbDate, venueNow } from './../src/slots/venue-time.js';

const API = '/api/v1';
const LOGIN = `${API}/admin/auth/login`;
const DOMAIN = '@bookings.test';
const PREFIX = 'E2E Bookings';
/** Every customer phone in this file starts with this, for cleanup. */
const PHONE = '+88017990000';
const password = 'e2e-password-123';
const admin = { email: `admin${DOMAIN}`, password };
const manager = { email: `manager${DOMAIN}`, password };

const today = venueNow().date;
const d1 = addDays(today, 2);
const d2 = addDays(today, 3);
const d3 = addDays(today, 4);

const stripe = {
  createCheckoutSession: vi.fn(async ({ bookingId }: { bookingId: string }) => ({ id: `cs_${bookingId}`, url: `https://stripe.test/${bookingId}` })),
  openSessionUrl: vi.fn(async () => null),
  expireSession: vi.fn(async () => undefined),
  refund: vi.fn(async (intentId: string) => `re_${intentId}`),
  cardLast4: vi.fn(async () => '4242'),
  parseWebhook: vi.fn((raw: Buffer, signature: string | undefined) => {
    if (signature !== 'good') throw new AppError('Invalid Stripe signature', 400, 'INVALID_SIGNATURE');
    return JSON.parse(raw.toString());
  }),
};
const email = { send: vi.fn(async () => true) };

describe('Bookings (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let groundId: string;

  const cleanup = async () => {
    const grounds = await prisma.ground.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
    const ids = grounds.map((g) => g.id);
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
    await prisma.user.createMany({
      data: [
        { email: admin.email, name: 'Admin', role: 'admin', passwordHash },
        { email: manager.email, name: 'Manager', role: 'manager', passwordHash },
      ],
    });
    groundId = (await prisma.ground.create({
      data: { name: `${PREFIX} Main`, sport: 'football', hourlyPrice: 1000, openingHour: 8, closingHour: 12 },
    })).id;
    const slots = [d1, d2, d3].flatMap((date) => [8, 9, 10, 11].map((startHour) => ({
      groundId, date: toDbDate(date), startHour, price: 1000,
    })));
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
    await prisma.$disconnect();
  });

  async function signIn(creds: { email: string; password: string }) {
    const agent = request.agent(app.getHttpServer());
    await agent.post(LOGIN).send(creds).expect(200);
    return agent;
  }

  const http = () => request(app.getHttpServer());
  const slotAt = (date: string, startHour: number) =>
    prisma.slot.findUniqueOrThrow({ where: { groundId_date_startHour: { groundId, date: toDbDate(date), startHour } } });
  const booking = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id }, include: { payments: true } });
  const checkout = (date: string, hour: number, phoneSuffix: string, paymentMethod: 'card' | 'cash' = 'card') => http().post(`${API}/checkout`).send({
    groundId, date, hour, customerName: 'Rakib Hasan', customerEmail: 'Rakib@Example.com', customerPhone: `0179900000${phoneSuffix}`, paymentMethod,
  });
  const webhook = (event: object, signature = 'good') =>
    http().post(`${API}/stripe/webhook`).set('content-type', 'application/json').set('stripe-signature', signature).send(JSON.stringify(event));
  const paidEvent = (bookingId: string, intent: string, amount = 6000) => ({
    type: 'checkout.session.completed',
    data: { object: { metadata: { bookingId }, payment_intent: intent, payment_status: 'paid', amount_total: amount } },
  });

  describe('portal checkout', () => {
    let bookingId: string;

    it('holds the slot and creates a pending booking with the service fee', async () => {
      const res = await checkout(d1, 9, '1').expect(201);
      bookingId = res.body.data.bookingId;
      expect(res.body.data.checkoutUrl).toBe(`https://stripe.test/${bookingId}`);

      expect(await slotAt(d1, 9)).toMatchObject({ status: 'held', heldByBookingId: bookingId });
      expect(await booking(bookingId)).toMatchObject({
        status: 'pending', paymentStatus: 'unpaid', source: 'portal', amount: 1000, serviceFee: 5000, total: 6000,
        contactEmail: 'rakib@example.com', contactPhone: '+8801799000001', stripeCheckoutSessionId: `cs_${bookingId}`,
      });
      const pub = await http().get(`${API}/grounds/${groundId}/slots`).query({ date: d1 }).expect(200);
      expect(pub.body.data.find((s: { startHour: number }) => s.startHour === 9).available).toBe(false);
    });

    it('refuses a second checkout for the same slot', async () => {
      expect((await checkout(d1, 9, '9').expect(409)).body.code).toBe('SLOT_NOT_AVAILABLE');
    });

    it('confirms on the Stripe webhook, once, and emails the customer', async () => {
      await webhook(paidEvent(bookingId, 'pi_1'), 'bad').expect(400);
      await webhook(paidEvent(bookingId, 'pi_1')).expect(200);
      await webhook(paidEvent(bookingId, 'pi_1')).expect(200);

      const b = await booking(bookingId);
      expect(b).toMatchObject({ status: 'confirmed', paymentStatus: 'paid', liveSlotId: b.slotId });
      expect(b.payments).toEqual([expect.objectContaining({ method: 'card', amount: 6000, status: 'succeeded', cardLast4: '4242' })]);
      expect(await slotAt(d1, 9)).toMatchObject({ status: 'booked', heldUntil: null });
      expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'rakib@example.com', subject: expect.stringContaining('confirmed') }));
    });

    it('shows the booking through the signed link only', async () => {
      await http().get(`${API}/bookings/${bookingId}`).query({ token: 'nope' }).expect(404);
      const res = await http().get(`${API}/bookings/${bookingId}`).query({ token: bookingToken(bookingId) }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'confirmed', total: 6000, slot: { date: d1, startHour: 9, endHour: 10 }, canCancel: true });
      expect(res.body.data).not.toHaveProperty('notes');
    });

    it('fills slot.booking and the calendar for staff', async () => {
      const agent = await signIn(manager);
      const slots = await agent.get(`${API}/admin/slots`).query({ groundId, date: d1, status: 'booked' }).expect(200);
      expect(slots.body.data.data[0].booking).toMatchObject({ id: bookingId, customerName: 'Rakib Hasan', paymentStatus: 'paid' });
      const cal = await agent.get(`${API}/admin/slots/calendar`).query({ from: d1, to: d1, groundId }).expect(200);
      expect(cal.body.data.slots[0]).toMatchObject({ customerPhone: '+8801799000001', amount: 6000, advancePaid: 6000 });
    });

    it('lets the customer cancel with a full refund, freeing the slot', async () => {
      const res = await http().post(`${API}/bookings/${bookingId}/cancel`).query({ token: bookingToken(bookingId) }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'cancelled', paymentStatus: 'refunded', canCancel: false });
      expect(stripe.refund).toHaveBeenCalledWith('pi_1');
      expect((await booking(bookingId)).payments[0]).toMatchObject({ status: 'refunded', stripeRefundId: 're_pi_1' });
      expect(await slotAt(d1, 9)).toMatchObject({ status: 'available' });
      expect((await http().post(`${API}/bookings/${bookingId}/cancel`).query({ token: bookingToken(bookingId) }).expect(409)).body.code)
        .toBe('BOOKING_ALREADY_CANCELLED');
    });
  });

  describe('pay at the venue (cash)', () => {
    let cashId: string;

    it('tells the portal that cash is offered, with the fee', async () => {
      const res = await http().get(`${API}/checkout/options`).expect(200);
      expect(res.body.data).toEqual({ cashEnabled: true, serviceFee: 5000, currency: 'bdt', holdMinutes: 15 });
    });

    it('books the slot with no Stripe step, pending until staff confirm', async () => {
      const res = await checkout(d1, 10, '8', 'cash').expect(201);
      cashId = res.body.data.bookingId;
      expect(res.body.data).toMatchObject({ paymentMethod: 'cash', checkoutUrl: null, confirmationUrl: expect.stringContaining(`/confirmation/${cashId}?token=`) });
      expect(await slotAt(d1, 10)).toMatchObject({ status: 'booked', heldUntil: null });
      expect(await booking(cashId)).toMatchObject({ status: 'pending', paymentStatus: 'unpaid', payAtVenue: true, total: 6000, stripeCheckoutSessionId: null });
      expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringContaining('received') }));
    });

    it('shows in the review queue, and staff confirm it then record the cash', async () => {
      const agent = await signIn(manager);
      const queue = await agent.get(`${API}/admin/bookings`).query({ status: 'pending', groundId }).expect(200);
      expect(queue.body.data.data).toContainEqual(expect.objectContaining({ id: cashId, payAtVenue: true, source: 'portal' }));

      const confirmed = await agent.post(`${API}/admin/bookings/${cashId}/confirm`).send({ notifyCustomer: true }).expect(200);
      expect(confirmed.body.data).toMatchObject({ status: 'confirmed', paymentStatus: 'unpaid', due: 6000 });
      const paid = await agent.post(`${API}/admin/bookings/${cashId}/payments`).send({ amount: 6000, method: 'cash' }).expect(201);
      expect(paid.body.data).toMatchObject({ paymentStatus: 'paid', due: 0 });
    });

    it('lets the customer pay a pending cash booking online instead, which confirms it', async () => {
      const { bookingId } = (await checkout(d2, 8, '8', 'cash').expect(201)).body.data;
      const token = bookingToken(bookingId);
      const before = await http().get(`${API}/bookings/${bookingId}`).query({ token }).expect(200);
      expect(before.body.data).toMatchObject({ status: 'pending', payAtVenue: true, paid: 0, due: 6000, canPay: true });

      const pay = await http().post(`${API}/bookings/${bookingId}/pay`).query({ token }).expect(200);
      expect(pay.body.data).toMatchObject({ checkoutUrl: `https://stripe.test/${bookingId}`, amount: 6000 });
      expect(stripe.createCheckoutSession).toHaveBeenLastCalledWith(expect.objectContaining({ purpose: 'due', total: 6000 }));

      await webhook({
        type: 'checkout.session.completed',
        data: { object: { metadata: { bookingId, purpose: 'due' }, payment_intent: 'pi_pay_now', payment_status: 'paid', amount_total: 6000 } },
      }).expect(200);
      const after = await http().get(`${API}/bookings/${bookingId}`).query({ token }).expect(200);
      expect(after.body.data).toMatchObject({ status: 'confirmed', paymentStatus: 'paid', paid: 6000, due: 0, canPay: false });
      expect((await http().post(`${API}/bookings/${bookingId}/pay`).query({ token }).expect(409)).body.code).toBe('NOTHING_DUE');
    });

    it('lets the customer cancel a pending cash booking through the link', async () => {
      const { bookingId } = (await checkout(d1, 11, '8', 'cash').expect(201)).body.data;
      const res = await http().post(`${API}/bookings/${bookingId}/cancel`).query({ token: bookingToken(bookingId) }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'cancelled', payAtVenue: true });
      expect(await slotAt(d1, 11)).toMatchObject({ status: 'available' });
    });
  });

  describe('holds that lapse', () => {
    it('releases the slot, then re-takes it if the late payment finds it free', async () => {
      const { bookingId } = (await checkout(d3, 8, '2').expect(201)).body.data;
      await prisma.slot.update({ where: { id: (await slotAt(d3, 8)).id }, data: { heldUntil: new Date(Date.now() - 1000) } });
      expect(await app.get(BookingJobs).releaseExpiredHolds()).toBeGreaterThanOrEqual(1);
      expect(await booking(bookingId)).toMatchObject({ status: 'cancelled', liveSlotId: null });
      expect(stripe.expireSession).toHaveBeenCalledWith(`cs_${bookingId}`);

      await webhook(paidEvent(bookingId, 'pi_late_free')).expect(200);
      expect(await booking(bookingId)).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
      expect(await slotAt(d3, 8)).toMatchObject({ status: 'booked' });
    });

    it('refunds a late payment when someone else has taken the slot', async () => {
      const { bookingId } = (await checkout(d3, 9, '3').expect(201)).body.data;
      await prisma.slot.update({ where: { id: (await slotAt(d3, 9)).id }, data: { heldUntil: new Date(Date.now() - 1000) } });
      await app.get(BookingJobs).releaseExpiredHolds();
      await checkout(d3, 9, '4').expect(201);

      await webhook(paidEvent(bookingId, 'pi_late_taken')).expect(200);
      expect(stripe.refund).toHaveBeenCalledWith('pi_late_taken');
      expect(await booking(bookingId)).toMatchObject({ status: 'cancelled', paymentStatus: 'refunded' });
    });
  });

  describe('staff bookings', () => {
    let partialId: string;

    it('books with an advance, then collects the rest', async () => {
      const agent = await signIn(manager);
      const { id: slotId } = await slotAt(d2, 10);
      const res = await agent.post(`${API}/admin/bookings`).send({
        slotId, customer: { name: 'Walk In', phone: '01799000005', email: 'walk@in.test' },
        payment: { type: 'partial', method: 'cash', amount: 400, dueDate: d2, note: 'Rest at the counter' },
      }).expect(201);
      partialId = res.body.data.id;
      expect(res.body.data).toMatchObject({
        source: 'staff', status: 'confirmed', paymentStatus: 'partial', total: 1000, serviceFee: 0, paid: 400, due: 600,
        dueDate: d2, dueNote: 'Rest at the counter', createdBy: { name: 'Manager' }, bookingNumber: expect.stringMatching(/^CT-[A-Z2-9]{5}$/),
      });
      expect((await agent.post(`${API}/admin/bookings`).send({
        slotId, customer: { name: 'X', phone: '01799000006', email: 'x@in.test' }, payment: { type: 'none' },
      }).expect(409)).body.code).toBe('SLOT_NOT_AVAILABLE');

      expect((await agent.post(`${API}/admin/bookings/${partialId}/payments`).send({ amount: 700, method: 'cash' }).expect(400)).body.code)
        .toBe('PAYMENT_EXCEEDS_DUE');
      const paid = await agent.post(`${API}/admin/bookings/${partialId}/payments`).send({ amount: 600, method: 'bank_transfer' }).expect(201);
      expect(paid.body.data).toMatchObject({ paymentStatus: 'paid', paid: 1000, due: 0 });
    });

    it('puts unpaid bookings in the review queue until confirmed', async () => {
      const agent = await signIn(admin);
      const { id: slotId } = await slotAt(d2, 11);
      const created = await agent.post(`${API}/admin/bookings`).send({
        slotId, customer: { name: 'Phone Booker', phone: '01799000007', email: 'phone@in.test' }, payment: { type: 'none' },
      }).expect(201);
      expect(created.body.data).toMatchObject({ status: 'pending', paymentStatus: 'unpaid' });
      expect(await slotAt(d2, 11)).toMatchObject({ status: 'booked' });

      const queue = await agent.get(`${API}/admin/bookings`).query({ status: 'pending', groundId }).expect(200);
      expect(queue.body.data.data.map((b: { id: string }) => b.id)).toContain(created.body.data.id);
      expect(queue.body.data.counts.confirmed).toBeGreaterThanOrEqual(1);

      const confirmed = await agent.post(`${API}/admin/bookings/${created.body.data.id}/confirm`).send({ markPaid: true }).expect(200);
      expect(confirmed.body.data).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
      expect((await agent.post(`${API}/admin/bookings/${created.body.data.id}/confirm`).send({}).expect(409)).body.code).toBe('BOOKING_NOT_PENDING');
    });

    it('shows the detail with payments and the activity timeline', async () => {
      const agent = await signIn(manager);
      const res = await agent.get(`${API}/admin/bookings/${partialId}`).expect(200);
      expect(res.body.data.payments.map((p: { method: string; amount: number }) => [p.method, p.amount])).toEqual([['cash', 400], ['bank_transfer', 600]]);
      expect(res.body.data.events.map((e: { type: string }) => e.type)).toEqual(
        expect.arrayContaining(['created', 'payment_received', 'confirmed', 'email_sent']),
      );
      expect(res.body.data.customer.totalBookings).toBe(1);
    });

    it('blocking the booked slot needs cancelBooking, which cancels and refunds it', async () => {
      const agent = await signIn(manager);
      const { id } = await slotAt(d2, 10);
      expect((await agent.post(`${API}/admin/slots/${id}/block`).send({ reason: 'maintenance' }).expect(409)).body.code).toBe('SLOT_HAS_BOOKING');

      const res = await agent.post(`${API}/admin/slots/${id}/block`).send({ reason: 'maintenance', note: 'Pipe burst', cancelBooking: true }).expect(200);
      expect(res.body.data).toMatchObject({ cancelledBooking: true, slot: { status: 'blocked', block: { reason: 'maintenance' } } });
      expect(await booking(partialId)).toMatchObject({ status: 'cancelled', paymentStatus: 'refunded' });
    });
  });

  describe('customers and dashboard', () => {
    it('finds a customer by phone, in any format', async () => {
      const agent = await signIn(manager);
      const res = await agent.get(`${API}/admin/customers/search`).query({ phone: '+880 1799-000005' }).expect(200);
      expect(res.body.data).toMatchObject({ name: 'Walk In', phone: '+8801799000005' });
    });

    it('lists customers with totals and stats, and refuses duplicate phones', async () => {
      const agent = await signIn(admin);
      const res = await agent.get(`${API}/admin/customers`).query({ search: '01799000007' }).expect(200);
      expect(res.body.data.data[0]).toMatchObject({ name: 'Phone Booker', bookings: 1, totalSpent: 1000, dueAmount: 0, tag: 'new' });
      expect(res.body.data.stats.total).toBeGreaterThanOrEqual(1);
      const dup = await agent.post(`${API}/admin/customers`).send({ name: 'Dup', phone: '01799000007', email: 'd@x.test' }).expect(409);
      expect(dup.body.code).toBe('CUSTOMER_PHONE_TAKEN');
    });

    it('refuses to delete a customer with an upcoming booking', async () => {
      const agent = await signIn(admin);
      const { id } = (await agent.get(`${API}/admin/customers/search`).query({ phone: '01799000007' })).body.data;
      expect((await agent.delete(`${API}/admin/customers/${id}`).expect(409)).body.code).toBe('CUSTOMER_HAS_UPCOMING_BOOKINGS');
    });

    it('returns dashboard numbers and upcoming bookings', async () => {
      const agent = await signIn(manager);
      const stats = await agent.get(`${API}/admin/dashboard/stats`).expect(200);
      expect(stats.body.data).toMatchObject({ todayRevenue: expect.any(Number), activeGrounds: expect.any(Number), bookingsTodayByGround: expect.any(Array) });
      const upcoming = await agent.get(`${API}/admin/bookings/upcoming`).query({ limit: 20 }).expect(200);
      expect(upcoming.body.data.some((b: { ground: { id: string } }) => b.ground.id === groundId)).toBe(true);
    });
  });
});
