import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { BookingCancellationService } from './../src/bookings/booking-cancellation.service.js';
import { BookingJobs } from './../src/bookings/booking-jobs.js';
import { AppError } from './../src/common/app-error.js';
import { EmailService } from './../src/email/email.service.js';
import { StripeService } from './../src/payments/stripe.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { addDays, toDbDate, venueNow } from './../src/slots/venue-time.js';

const API = '/api/v1';
const PREFIX = 'E2E Hold Release';
/** Every customer phone in this file starts with this, for cleanup. */
const PHONE = '+8801799100';
const ROUNDS = 10;

const today = venueNow().date;
const date = addDays(today, 2);
const yesterday = addDays(today, -1);

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

describe('Hold release (e2e)', () => {
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
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await cleanup();
    groundId = (await prisma.ground.create({
      data: { name: `${PREFIX} Main`, sport: 'football', hourlyPrice: 1000, openingHour: 0, closingHour: 24 },
    })).id;
    const startHours = Array.from({ length: 24 }, (_, startHour) => startHour);
    await prisma.slot.createMany({ data: startHours.map((startHour) => ({ groundId, date: toDbDate(date), startHour, price: 1000 })) });
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeService).useValue(stripe)
      .overrideProvider(EmailService).useValue(email)
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  const slotAt = (hour: number, on = date) =>
    prisma.slot.findUniqueOrThrow({ where: { groundId_date_startHour_startMinute: { groundId, date: toDbDate(on), startHour: hour, startMinute: 0 } } });
  const booking = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id }, include: { payments: true } });

  /** Starts a card checkout, which holds the slot. */
  const hold = async (hour: number): Promise<string> => {
    const res = await request(app.getHttpServer()).post(`${API}/checkout`).send({
      groundId, date, hour, customerName: 'Rakib Hasan', customerEmail: 'rakib@example.com',
      customerPhone: `01799100${String(hour).padStart(3, '0')}`, paymentMethod: 'card',
    }).expect(201);
    return res.body.data.bookingId;
  };
  const lapse = async (hour: number) =>
    prisma.slot.update({ where: { id: (await slotAt(hour)).id }, data: { heldUntil: new Date(Date.now() - 1000) } });
  const payWebhook = (bookingId: string, intent: string) => request(app.getHttpServer())
    .post(`${API}/stripe/webhook`).set('content-type', 'application/json').set('stripe-signature', 'good')
    .send(JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { metadata: { bookingId }, payment_intent: intent, payment_status: 'paid', amount_total: 6000 } },
    }));

  it('keeps the booking and the money when a payment lands right after the sweep read it', async () => {
    const id = await hold(0);
    await lapse(0);
    const cancellation = app.get(BookingCancellationService);
    const realCancel = cancellation.cancel.bind(cancellation);
    // The sweep has read "pending" by the time cancel is called, so the payment lands in that gap.
    vi.spyOn(cancellation, 'cancel').mockImplementation(async (bookingId, opts) => {
      if (bookingId === id) await payWebhook(id, 'pi_gap').expect(200);
      return realCancel(bookingId, opts);
    });
    stripe.expireSession.mockClear();

    await app.get(BookingJobs).releaseExpiredHolds();

    const row = await booking(id);
    expect(row).toMatchObject({ status: 'confirmed', paymentStatus: 'paid', liveSlotId: (await slotAt(0)).id });
    expect(row.payments).toEqual([expect.objectContaining({ status: 'succeeded', stripePaymentIntentId: 'pi_gap' })]);
    expect(await slotAt(0)).toMatchObject({ status: 'booked' });
    expect(stripe.expireSession).not.toHaveBeenCalledWith(`cs_${id}`);
  });

  it('releases a hold whose slot has already ended, and the holds after it', async () => {
    const ended = await hold(1);
    const next = await hold(2);
    const endedSlot = await slotAt(1);
    await prisma.slot.update({ where: { id: endedSlot.id }, data: { date: toDbDate(yesterday), heldUntil: new Date(Date.now() - 1000) } });
    await lapse(2);

    await expect(app.get(BookingJobs).releaseExpiredHolds()).resolves.toBeGreaterThanOrEqual(2);

    expect(await booking(ended)).toMatchObject({ status: 'cancelled', liveSlotId: null });
    expect(await slotAt(1, yesterday)).toMatchObject({ status: 'available', heldByBookingId: null });
    expect(await booking(next)).toMatchObject({ status: 'cancelled', liveSlotId: null });
    expect(await slotAt(2)).toMatchObject({ status: 'available' });
  });

  it('survives an expired-session webhook after the slot has ended', async () => {
    const id = await hold(3);
    const slot = await slotAt(3);
    await prisma.slot.update({ where: { id: slot.id }, data: { date: toDbDate(yesterday) } });

    await request(app.getHttpServer())
      .post(`${API}/stripe/webhook`).set('content-type', 'application/json').set('stripe-signature', 'good')
      .send(JSON.stringify({ type: 'checkout.session.expired', data: { object: { metadata: { bookingId: id } } } }))
      .expect(200);

    expect(await booking(id)).toMatchObject({ status: 'cancelled' });
  });

  it(`never loses a payment when it races the release (${ROUNDS} rounds on a real database)`, async () => {
    const cancellation = app.get(BookingCancellationService);
    for (let round = 0; round < ROUNDS; round++) {
      const hour = 10 + round;
      const id = await hold(hour);
      const intent = `pi_race_${round}`;
      const [paid] = await Promise.allSettled([
        payWebhook(id, intent),
        cancellation.cancel(id, { actorId: null, refund: false, notify: false, unpaidOnly: true }),
      ]);
      // Stripe retries a failed delivery, for example if Postgres broke a lock cycle.
      if (paid.status === 'rejected' || paid.value.status !== 200) await payWebhook(id, intent).expect(200);

      const row = await booking(id);
      expect(row).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
      expect(row.payments).toHaveLength(1);
      expect(await slotAt(hour)).toMatchObject({ status: 'booked' });
    }
  });
});
