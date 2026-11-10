import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { EmailService } from './../src/email/email.service.js';
import { StripeService } from './../src/payments/stripe.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { addDays, toDbDate, venueNow } from './../src/slots/venue-time.js';
import { signInCustomer } from './sign-in-customer.js';

const API = '/api/v1';
const PREFIX = 'E2E Checkout Limits';
/** Every customer phone in this file starts with this, for cleanup. */
const PHONE = '+88017990050';
const LOCAL = '017990050';

const today = venueNow().date;
const date = addDays(today, 2);

const stripe = {
  createCheckoutSession: vi.fn(async ({ bookingId }: { bookingId: string }) => ({ id: `cs_${bookingId}`, url: `https://stripe.test/${bookingId}` })),
  openSessionUrl: vi.fn(async () => null), expireSession: vi.fn(async () => undefined),
};
const email = { send: vi.fn(async () => true) };

/** Cash, bKash and Nagad: sign-in required, at most 3 open per phone; every checkout is rate limited. */
describe('Checkout limits (e2e)', () => {
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
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await cleanup();
    groundId = (await prisma.ground.create({
      data: { name: `${PREFIX} Main`, sport: 'football', hourlyPrice: 1000, openingHour: 8, closingHour: 20 },
    })).id;
    await prisma.slot.createMany({ data: Array.from({ length: 12 }, (_, i) => ({ groundId, date: toDbDate(date), startHour: 8 + i, price: 1000 })) });
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
  const slotAt = (startHour: number) =>
    prisma.slot.findUniqueOrThrow({ where: { groundId_date_startHour_startMinute: { groundId, date: toDbDate(date), startHour, startMinute: 0 } } });
  const checkout = (
    client: ReturnType<typeof request.agent> | ReturnType<typeof http>, hour: number, phoneEnd: string, extra: object = { paymentMethod: 'cash' },
  ) => client.post(`${API}/checkout`).send({
    groundId, date, hour, customerName: 'Sabbir Ahmed', customerEmail: 'sabbir@limits.test', customerPhone: `${LOCAL}${phoneEnd}`, ...extra,
  });
  const bkash = () => ({ paymentMethod: 'bkash', reference: `L${randomBytes(5).toString('hex').toUpperCase()}`, payerNumber: '01811000050' });
  const setBkashNumber = () =>
    prisma.slotSettings.upsert({ where: { id: 1 }, create: { id: 1, bkashNumber: '+8801700000050' }, update: { bkashNumber: '+8801700000050' } });

  it('a guest cash, bKash or Nagad checkout is 401 SIGN_IN_REQUIRED and reserves nothing', async () => {
    const res = await checkout(http(), 8, '01').expect(401);
    expect(res.body).toMatchObject({ success: false, code: 'SIGN_IN_REQUIRED', error: expect.stringContaining('Sign in') });
    await setBkashNumber();
    expect((await checkout(http(), 8, '01', bkash()).expect(401)).body.code).toBe('SIGN_IN_REQUIRED');
    expect(await slotAt(8)).toMatchObject({ status: 'available' });
    expect(await prisma.booking.count({ where: { groundId, contactPhone: `${PHONE}01` } })).toBe(0);
  });

  it('a signed-in cash checkout books the slot on the verified phone', async () => {
    const customer = await signInCustomer(app, `${LOCAL}02`);
    const res = await checkout(customer, 9, '02').expect(201);
    expect(res.body.data).toMatchObject({ paymentMethod: 'cash', checkoutUrl: null });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: res.body.data.bookingId } }))
      .toMatchObject({ status: 'pending', payAtVenue: true, contactPhone: `${PHONE}02` });
    expect(await slotAt(9)).toMatchObject({ status: 'booked' });
  });

  describe('at most 3 open unpaid bookings per phone', () => {
    it('setup: a cash booking whose slot has ended and a card checkout on the phone', async () => {
      const customer = await signInCustomer(app, `${LOCAL}03`);
      const ended = (await checkout(customer, 10, '03').expect(201)).body.data.bookingId as string;
      const { slotId } = await prisma.booking.findUniqueOrThrow({ where: { id: ended } });
      await prisma.slot.update({ where: { id: slotId }, data: { date: toDbDate(addDays(today, -1)) } });
      await checkout(customer, 11, '03', { paymentMethod: 'card' }).expect(201);
    });

    it('neither counts; 3 open (cash and bKash) are allowed, the 4th is 409 TOO_MANY_OPEN_BOOKINGS and reserves nothing', async () => {
      const customer = await signInCustomer(app, `${LOCAL}03`);
      await checkout(customer, 12, '03').expect(201);
      await setBkashNumber();
      await checkout(customer, 13, '03', bkash()).expect(201);
      await checkout(customer, 14, '03').expect(201);
      const res = await checkout(customer, 15, '03').expect(409);
      expect(res.body).toMatchObject({ code: 'TOO_MANY_OPEN_BOOKINGS', error: expect.stringContaining('Pay or cancel') });
      expect(await slotAt(15)).toMatchObject({ status: 'available' });
      // Another phone is not affected.
      await checkout(await signInCustomer(app, `${LOCAL}04`), 15, '04').expect(201);
    });
  });

  it('allows 5 checkouts per 10 minutes per IP + phone, then 429 TOO_MANY_ATTEMPTS', async () => {
    for (let i = 0; i < 5; i++) await checkout(http(), 16, '05').expect(401);
    const res = await checkout(http(), 16, '05').expect(429);
    expect(res.body).toMatchObject({ success: false, code: 'TOO_MANY_ATTEMPTS' });
    // Normalised: the same number written another way is the same tracker; another number is not.
    await checkout(http(), 16, '05', { paymentMethod: 'cash', customerPhone: `+88${LOCAL}05` }).expect(429);
    await checkout(http(), 16, '06').expect(401);
    expect(await slotAt(16)).toMatchObject({ status: 'available' });
  });
});
