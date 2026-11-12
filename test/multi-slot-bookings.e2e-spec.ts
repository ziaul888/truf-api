import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { env } from './../src/config/env.js';
import { hashPassword } from './../src/auth/password.js';
import { EmailService } from './../src/email/email.service.js';
import { StripeService } from './../src/payments/stripe.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { addDays, toDbDate, venueNow } from './../src/slots/venue-time.js';
import { signInCustomer } from './sign-in-customer.js';

const API = '/api/v1';
const DOMAIN = '@multi-slot.test';
const PREFIX = 'E2E Multi Slot';
/** Every customer phone in this file starts with this, for cleanup. */
const PHONE = '+88017990050';
const admin = { email: `admin${DOMAIN}`, password: 'e2e-password-123' };
const BKASH = '+8801700000051';

const today = venueNow().date;
/** One date per scenario, so scenarios never share a slot. */
const day = (offset: number) => addDays(today, offset);
const HOURS = [8, 9, 10, 11, 12, 13, 14, 15];

/** A fresh TrxID per call, so a second run never clashes with the first. */
const trx = () => `T${randomBytes(5).toString('hex').toUpperCase()}`;

const stripe = {
  createCheckoutSession: vi.fn(async (args: { bookingId: string; total: number; description: string }) => ({ id: `cs_${args.bookingId}`, url: `https://stripe.test/${args.bookingId}` })),
  openSessionUrl: vi.fn(async () => null), expireSession: vi.fn(async () => undefined),
  refund: vi.fn(async (intentId: string) => `re_${intentId}`), cardLast4: vi.fn(async () => '4242'), parseWebhook: vi.fn(),
};
const email = { send: vi.fn(async () => true) };

describe('Multi-slot bookings (e2e)', () => {
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
    await prisma.slotEvent.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.slot.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.ground.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await cleanup();
    await prisma.user.create({ data: { email: admin.email, name: 'Admin', role: 'admin', passwordHash: await hashPassword(admin.password) } });
    groundId = (await prisma.ground.create({
      data: { name: `${PREFIX} Main`, sport: 'football', hourlyPrice: 1000, openingHour: 8, closingHour: 16 },
    })).id;
    const dates = [3, 4, 5, 6, 7, 8, 9, 10].map(day);
    await prisma.slot.createMany({
      data: dates.flatMap((date) => HOURS.map((startHour) => ({ groundId, date: toDbDate(date), startHour, price: 1000 }))),
    });
    // The settings row is shared: wallets need a number.
    await prisma.slotSettings.upsert({ where: { id: 1 }, create: { id: 1, bkashNumber: BKASH }, update: { bkashNumber: BKASH } });
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
    await prisma.slotSettings.updateMany({ data: { bkashNumber: null } });
    await prisma.$disconnect();
  });

  const http = () => request(app.getHttpServer());
  const signInAdmin = async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post(`${API}/admin/auth/login`).send(admin).expect(200);
    return agent;
  };
  const slotAt = (date: string, startHour: number) =>
    prisma.slot.findUniqueOrThrow({ where: { groundId_date_startHour_startMinute: { groundId, date: toDbDate(date), startHour, startMinute: 0 } } });
  const statuses = async (date: string, hours: number[]) => Promise.all(hours.map(async (h) => (await slotAt(date, h)).status));
  /** A fresh phone per checkout: the open-unpaid cap (3) and the checkout rate limit are per phone. */
  let phoneSeq = 20;
  const nextPhone = () => `017990050${String(++phoneSeq).padStart(2, '0')}`;
  const portalBody = (date: string, phone: string, extra: object) => ({
    groundId, date, customerName: 'Nusrat Jahan', customerEmail: 'nusrat@multi-slot.test', customerPhone: phone, ...extra,
  });
  /** The settings row is shared (other files wipe it): set the bKash number right before a wallet checkout. */
  const walletsOn = () => prisma.slotSettings.upsert({ where: { id: 1 }, create: { id: 1, bkashNumber: BKASH }, update: { bkashNumber: BKASH } });
  /** Cash, bKash and Nagad need a signed-in customer; a card checkout does not. */
  const signedInCheckout = async (date: string, extra: object, status = 201) => {
    const phone = nextPhone();
    if ('reference' in extra) await walletsOn();
    return (await signInCustomer(app, phone)).post(`${API}/checkout`).send(portalBody(date, phone, extra)).expect(status);
  };
  const guestCheckout = (date: string, extra: object) => http().post(`${API}/checkout`).send(portalBody(date, nextPhone(), extra));
  const slots = (...hours: number[]) => hours.map((hour) => ({ hour }));
  const bookingOf = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id }, include: { bookingSlots: true, payments: true } });

  it('tells the portal how many slots one booking can hold', async () => {
    const res = await http().get(`${API}/checkout/options`).expect(200);
    expect(res.body.data.maxSlotsPerBooking).toBe(4);
  });

  it('rollout gate refuses both multi-slot endpoints but keeps legacy single-slot bookings working', async () => {
    env.MULTI_SLOT_BOOKINGS_ENABLED = false;
    try {
      const options = await http().get(`${API}/checkout/options`).expect(200);
      expect(options.body.data.maxSlotsPerBooking).toBe(1);
      const portal = await guestCheckout(day(10), { paymentMethod: 'card', slots: slots(8, 9) }).expect(400);
      expect(portal.body.code).toBe('TOO_MANY_SLOTS');
      const agent = await signInAdmin();
      const ids = [(await slotAt(day(10), 8)).id, (await slotAt(day(10), 9)).id];
      const customer = { name: 'Rollout Walk In', phone: '01799005013' };
      const staff = await agent.post(`${API}/admin/bookings`).send({ slotIds: ids, customer, payment: { type: 'none' } }).expect(400);
      expect(staff.body.code).toBe('TOO_MANY_SLOTS');
      expect(await statuses(day(10), [8, 9])).toEqual(['available', 'available']);
      await guestCheckout(day(10), { paymentMethod: 'card', startHour: 8, startMinute: 0 }).expect(201);
      await agent.post(`${API}/admin/bookings`).send({ slotId: ids[1], customer, payment: { type: 'none' } }).expect(201);
    } finally {
      env.MULTI_SLOT_BOOKINGS_ENABLED = true;
    }
  });

  describe('portal checkout', () => {
    it('cash: books two slots as ONE booking with one service fee', async () => {
      const res = await signedInCheckout(day(3), { paymentMethod: 'cash', slots: slots(10, 8) });
      const booking = await bookingOf(res.body.data.bookingId);
      expect(booking).toMatchObject({ status: 'pending', payAtVenue: true, amount: 2000, total: 2000 + booking.serviceFee });
      // The earliest slot is the primary; both are live in BookingSlot.
      expect((await slotAt(day(3), 8)).id).toBe(booking.slotId);
      expect(booking.bookingSlots.map((s) => s.slotId).sort()).toEqual([(await slotAt(day(3), 8)).id, (await slotAt(day(3), 10)).id].sort());
      expect(booking.bookingSlots.every((s) => s.liveSlotId === s.slotId && s.price === 1000)).toBe(true);
      expect(await statuses(day(3), [8, 9, 10])).toEqual(['booked', 'available', 'booked']);
    });

    it('bKash: one pending payment for the combined total (fee once)', async () => {
      const res = await signedInCheckout(day(4), { paymentMethod: 'bkash', slots: slots(8, 9), reference: trx(), payerNumber: '01811000051' });
      const booking = await bookingOf(res.body.data.bookingId);
      expect(booking.payments).toHaveLength(1);
      expect(booking.payments[0]).toMatchObject({ method: 'bkash', status: 'pending', amount: 2000 + booking.serviceFee });
      expect(booking.total).toBe(2000 + booking.serviceFee);
    });

    it('card: holds every slot, and Stripe is asked for the combined total', async () => {
      stripe.createCheckoutSession.mockClear();
      const res = await guestCheckout(day(5), { paymentMethod: 'card', slots: slots(9, 10, 11) }).expect(201);
      const booking = await bookingOf(res.body.data.bookingId);
      expect(await statuses(day(5), [9, 10, 11])).toEqual(['held', 'held', 'held']);
      const held = await prisma.slot.findMany({ where: { heldByBookingId: booking.id } });
      expect(held).toHaveLength(3);
      expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ bookingId: booking.id, total: 3000 + booking.serviceFee }));
    });

    it('still takes the old single-slot body, and the booking response keeps `slot`', async () => {
      const res = await signedInCheckout(day(6), { paymentMethod: 'cash', hour: 12 });
      const booking = await bookingOf(res.body.data.bookingId);
      expect(booking).toMatchObject({ amount: 1000 });
      expect(booking.bookingSlots).toHaveLength(1);
      const link = await http().get(`${API}/bookings/${booking.id}`).query({ token: res.body.data.confirmationUrl.split('token=')[1] }).expect(200);
      expect(link.body.data).toMatchObject({ slotCount: 1, slot: { startTime: '12:00' }, slots: [expect.objectContaining({ startTime: '12:00', price: 1000, status: 'active' })] });
    });

    it('refuses 5 slots, a mix of both body styles, and a repeated slot', async () => {
      const five = await guestCheckout(day(7), { paymentMethod: 'card', slots: slots(8, 9, 10, 11, 12) }).expect(400);
      expect(five.body.code).toBe('TOO_MANY_SLOTS');
      const both = await guestCheckout(day(7), { paymentMethod: 'card', hour: 8, slots: slots(9) }).expect(400);
      expect(both.body.code).toBe('VALIDATION_FAILED');
      const repeated = await guestCheckout(day(7), { paymentMethod: 'card', slots: slots(8, 8) }).expect(400);
      expect(repeated.body.code).toBe('VALIDATION_FAILED');
      expect(await statuses(day(7), [8, 9, 10, 11, 12])).toEqual(Array(5).fill('available'));
    });

    it('a slot that is not free fails the whole booking and claims nothing', async () => {
      await prisma.slot.update({ where: { id: (await slotAt(day(7), 9)).id }, data: { status: 'blocked', blockReason: 'maintenance' } });
      const res = await guestCheckout(day(7), { paymentMethod: 'card', slots: slots(8, 9) }).expect(409);
      expect(res.body.code).toBe('SLOT_NOT_AVAILABLE');
      expect(await slotAt(day(7), 8)).toMatchObject({ status: 'available' });
    });

    it('two checkouts that overlap on one slot: exactly one wins, and the loser claims nothing', async () => {
      const [a, b] = await Promise.all([
        guestCheckout(day(8), { paymentMethod: 'card', slots: slots(8, 9) }),
        guestCheckout(day(8), { paymentMethod: 'card', slots: slots(9, 10) }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.code).toBe('SLOT_NOT_AVAILABLE');
      // Three slots in all were asked for twice over; only the winner's two are taken.
      const taken = (await statuses(day(8), [8, 9, 10])).filter((s) => s !== 'available');
      expect(taken).toHaveLength(2);
    });
  });

  describe('staff booking', () => {
    it('slotIds: books them together with a combined payment', async () => {
      const agent = await signInAdmin();
      const ids = [(await slotAt(day(9), 14)).id, (await slotAt(day(9), 13)).id];
      const res = await agent.post(`${API}/admin/bookings`).send({
        slotIds: ids, customer: { name: 'Walk In', phone: '01799005010', email: 'walkin@multi-slot.test' }, payment: { type: 'full', method: 'cash' },
      }).expect(201);
      expect(res.body.data).toMatchObject({ status: 'confirmed', paymentStatus: 'paid', amount: 2000, total: 2000, serviceFee: 0, slotCount: 2 });
      expect(res.body.data.slot.startTime).toBe('13:00');
      expect(res.body.data.slots.map((s: { startTime: string }) => s.startTime)).toEqual(['13:00', '14:00']);
      expect(await statuses(day(9), [13, 14])).toEqual(['booked', 'booked']);
    });

    it('the old single slotId still works', async () => {
      const agent = await signInAdmin();
      const res = await agent.post(`${API}/admin/bookings`).send({
        slotId: (await slotAt(day(9), 15)).id, customer: { name: 'Walk In', phone: '01799005011' }, payment: { type: 'none' },
      }).expect(201);
      expect(res.body.data).toMatchObject({ status: 'pending', slotCount: 1, amount: 1000 });
    });

    it('refuses slots of different dates and more than 4', async () => {
      const agent = await signInAdmin();
      const mixed = [(await slotAt(day(9), 8)).id, (await slotAt(day(8), 15)).id];
      const customer = { name: 'Walk In', phone: '01799005012' };
      expect((await agent.post(`${API}/admin/bookings`).send({ slotIds: mixed, customer, payment: { type: 'none' } }).expect(400)).body.code)
        .toBe('SLOTS_MUST_SHARE_GROUND_DATE');
      const five = await Promise.all([8, 9, 10, 11, 12].map(async (h) => (await slotAt(day(9), h)).id));
      expect((await agent.post(`${API}/admin/bookings`).send({ slotIds: five, customer, payment: { type: 'none' } }).expect(400)).body.code)
        .toBe('TOO_MANY_SLOTS');
    });
  });

  describe('cancelling', () => {
    it('is all or nothing: one cancel frees every slot and clears every live index', async () => {
      const agent = await signInAdmin();
      const res = await signedInCheckout(day(6), { paymentMethod: 'cash', slots: slots(13, 14) });
      const id = res.body.data.bookingId;
      await agent.post(`${API}/admin/bookings/${id}/cancel`).send({ refund: true, notifyCustomer: false }).expect(200);
      expect(await statuses(day(6), [13, 14])).toEqual(['available', 'available']);
      const booking = await bookingOf(id);
      expect(booking).toMatchObject({ status: 'cancelled', liveSlotId: null });
      expect(booking.bookingSlots.every((s) => s.liveSlotId === null && s.cancelledAt !== null)).toBe(true);
      // The slots can be booked again.
      await signedInCheckout(day(6), { paymentMethod: 'cash', slots: slots(13, 14) });
    });

    it('blocking one slot of a booking cancels the whole booking: only that slot ends blocked', async () => {
      const agent = await signInAdmin();
      const res = await signedInCheckout(day(7), { paymentMethod: 'cash', slots: slots(14, 15) });
      const blocked = await slotAt(day(7), 15);
      await agent.post(`${API}/admin/slots/${blocked.id}/block`).send({ reason: 'maintenance', cancelBooking: true }).expect(200);
      expect(await statuses(day(7), [14, 15])).toEqual(['available', 'blocked']);
      expect(await bookingOf(res.body.data.bookingId)).toMatchObject({ status: 'cancelled' });
    });
  });
});
