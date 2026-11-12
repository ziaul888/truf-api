import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { hashPassword } from './../src/auth/password.js';
import { BookingSeriesBooker } from './../src/booking-series/booking-series-booker.js';
import { EmailService } from './../src/email/email.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { addDays, toDbDate, venueNow } from './../src/slots/venue-time.js';

const API = '/api/v1';
const DOMAIN = '@booking-series.test';
const PREFIX = 'E2E Booking Series';
/** Every customer phone in this file starts with this, for cleanup. */
const PHONE = '+88017990090';
const admin = { email: `admin${DOMAIN}`, password: 'e2e-password-123' };
const manager = { email: `manager${DOMAIN}`, password: 'e2e-password-123' };
const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const today = venueNow().date;
/** d(1) is tomorrow: nothing here depends on the time of day. */
const d = (n: number) => addDays(today, n);
const customer = { name: 'Series Team', phone: '01799009001', email: 'series@example.com' };

type SeriesBody = { bookings: { id: string; date: string; status: string; total: number; paid: number; due: number }[] } & Record<string, unknown>;

describe('Booking series (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let groundId: string;
  let adminAgent: ReturnType<typeof request.agent>;
  let managerAgent: ReturnType<typeof request.agent>;
  const send = vi.fn(async () => true);
  let fixedId: string;
  let ongoingId: string;

  const cleanup = async () => {
    const ids = (await prisma.ground.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((g) => g.id);
    await prisma.bookingSeriesSkip.deleteMany({ where: { series: { groundId: { in: ids } } } });
    await prisma.bookingEvent.deleteMany({ where: { booking: { groundId: { in: ids } } } });
    await prisma.payment.deleteMany({ where: { booking: { groundId: { in: ids } } } });
    await prisma.bookingSlot.deleteMany({ where: { booking: { groundId: { in: ids } } } });
    await prisma.booking.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.bookingSeries.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { phone: { startsWith: PHONE } } });
    await prisma.slotEvent.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.slot.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.ground.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  };

  /** Slots at 20:00 and 21:00 on d(from)…d(to), as the generator would make them. */
  const seedSlots = (from: number, to: number) => prisma.slot.createMany({
    data: Array.from({ length: to - from + 1 }, (_, i) => [20, 21].map((startHour) => ({ groundId, date: toDbDate(d(from + i)), startHour, price: 1000 }))).flat(),
  });
  const slotAt = (n: number, startHour: number) => prisma.slot.findFirstOrThrow({ where: { groundId, date: toDbDate(d(n)), startHour } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await cleanup();
    const passwordHash = await hashPassword(admin.password);
    await prisma.user.createMany({
      data: [
        { email: admin.email, name: 'Admin', role: 'admin', passwordHash },
        { email: manager.email, name: 'Manager', role: 'manager', passwordHash },
      ],
    });
    groundId = (await prisma.ground.create({
      data: { name: `${PREFIX} Main`, sport: 'football', hourlyPrice: 1000, openingHour: 0, closingHour: 24 },
    })).id;
    await seedSlots(1, 7);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailService).useValue({ send })
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    // One sign-in per role for the whole file: the login endpoint is rate limited.
    adminAgent = request.agent(app.getHttpServer());
    await adminAgent.post(`${API}/admin/auth/login`).send(admin).expect(200);
    managerAgent = request.agent(app.getHttpServer());
    await managerAgent.post(`${API}/admin/auth/login`).send(manager).expect(200);

    // d2 at 21:00 blocked by staff, d3 at 21:00 already booked (unpaid staff booking).
    await prisma.slot.update({ where: { id: (await slotAt(2, 21)).id }, data: { status: 'blocked', blockReason: 'maintenance' } });
    await adminAgent.post(`${API}/admin/bookings`).send({
      slotId: (await slotAt(3, 21)).id, customer: { name: 'Other Team', phone: '01799009002' }, payment: { type: 'none' },
    }).expect(201);
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await prisma.$disconnect();
  });

  const fixed = { startHour: 21, weekdays: ALL_DAYS, fromDate: d(1), untilDate: d(7) };

  it('previews the dates, marking a blocked and a booked one (managers may)', async () => {
    const res = await managerAgent.post(`${API}/admin/booking-series/preview`).send({ groundId, ...fixed }).expect(200);
    expect(res.body.data).toMatchObject({ bookableCount: 5, total: 5000, horizon: d(7) });
    expect(res.body.data.dates).toHaveLength(7);
    expect(res.body.data.dates[1]).toEqual({ date: d(2), slotId: expect.any(String), price: 1000, available: false, reason: 'blocked' });
    expect(res.body.data.dates[2]).toMatchObject({ date: d(3), available: false, reason: 'booked' });
    expect(res.body.data.dates[0]).toEqual({ date: d(1), slotId: (await slotAt(1, 21)).id, price: 1000, available: true });
  });

  it('validates the range and the ground', async () => {
    const bad = await adminAgent.post(`${API}/admin/booking-series/preview`).send({ groundId, ...fixed, untilDate: d(40) });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    const unknown = await adminAgent.post(`${API}/admin/booking-series/preview`)
      .send({ ...fixed, groundId: '00000000-0000-4000-8000-000000000000' });
    expect(unknown.status).toBe(404);
  });

  it('books the free dates confirmed, sends no email, and spreads an advance earliest first', async () => {
    send.mockClear();
    const res = await adminAgent.post(`${API}/admin/booking-series`).send({
      groundId, ...fixed, customer, notes: 'Friday league', payment: { type: 'partial', method: 'cash', amount: 2500 },
    });
    expect(res.status).toBe(201);
    const body = res.body.data as SeriesBody;
    fixedId = body.id as string;
    expect(body).toMatchObject({
      status: 'active', startHour: 21, endHour: 22, fromDate: d(1), untilDate: d(7), bookedThrough: d(7),
      ground: { id: groundId }, customer: { name: customer.name, phone: '+8801799009001' },
      totals: { bookings: 5, total: 5000, paid: 2500, due: 2500 },
      skipped: [{ date: d(2), reason: 'blocked' }, { date: d(3), reason: 'booked' }],
    });
    expect(body.bookings.map((b) => [b.date, b.status, b.paid])).toEqual([
      [d(1), 'confirmed', 1000], [d(4), 'confirmed', 1000], [d(5), 'confirmed', 500], [d(6), 'confirmed', 0], [d(7), 'confirmed', 0],
    ]);
    expect(send).not.toHaveBeenCalled();

    const detail = await adminAgent.get(`${API}/admin/bookings/${body.bookings[2]!.id}`).expect(200);
    expect(detail.body.data).toMatchObject({ seriesId: fixedId, source: 'staff', paymentStatus: 'partial', dueDate: null, serviceFee: 0 });
    expect(detail.body.data.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['created', 'confirmed', 'payment_received']));
    expect((await slotAt(4, 21)).status).toBe('booked');
  });

  it('sums each calendar month', async () => {
    const res = await adminAgent.get(`${API}/admin/booking-series/${fixedId}`).expect(200);
    const { months, totals } = res.body.data as { months: { month: string; total: number; paid: number; due: number }[]; totals: { total: number } };
    expect(months.map((m) => m.month)).toEqual([...new Set([d(1), d(4), d(5), d(6), d(7)].map((x) => x.slice(0, 7)))]);
    expect(months.reduce((s, m) => s + m.total, 0)).toBe(totals.total);
    expect(months.reduce((s, m) => s + m.paid + m.due, 0)).toBe(5000);
  });

  it("collects one month's due, earliest first, and refuses more than is due", async () => {
    const month = d(6).slice(0, 7);
    const before = (await adminAgent.get(`${API}/admin/booking-series/${fixedId}`)).body.data as { months: { month: string; due: number }[] };
    const due = before.months.find((m) => m.month === month)!.due;
    const over = await adminAgent.post(`${API}/admin/booking-series/${fixedId}/payments`).send({ amount: due + 1, method: 'cash', month });
    expect(over.status).toBe(400);
    expect(over.body.code).toBe('AMOUNT_EXCEEDS_DUE');

    const res = await adminAgent.post(`${API}/admin/booking-series/${fixedId}/payments`)
      .send({ amount: due, method: 'bkash', reference: 'SERIESTRX01', month }).expect(201);
    const after = res.body.data as SeriesBody & { months: { month: string; due: number }[] };
    expect(after.months.find((m) => m.month === month)!.due).toBe(0);
    const payments = await prisma.payment.findMany({ where: { booking: { seriesId: fixedId }, method: 'bkash' } });
    expect(payments.filter((p) => p.reference === 'SERIESTRX01')).toHaveLength(1);
  });

  it('refuses a series with nothing free (409 NOTHING_TO_BOOK) and saves nothing', async () => {
    const count = () => prisma.bookingSeries.count({ where: { groundId } });
    const before = await count();
    const res = await adminAgent.post(`${API}/admin/booking-series`).send({
      groundId, startHour: 21, weekdays: ALL_DAYS, fromDate: d(2), untilDate: d(3), customer, payment: { type: 'none' },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOTHING_TO_BOOK');
    expect(await count()).toBe(before);
  });

  it('stops from a date with a refund: later bookings cancelled, earlier kept', async () => {
    const res = await adminAgent.post(`${API}/admin/booking-series/${fixedId}/stop`).send({ fromDate: d(5), refund: true }).expect(200);
    const body = res.body.data as SeriesBody;
    expect(body.status).toBe('stopped');
    expect(body.stoppedAt).not.toBeNull();
    expect(body.bookings.map((b) => [b.date, b.status])).toEqual([
      [d(1), 'confirmed'], [d(4), 'confirmed'], [d(5), 'cancelled'], [d(6), 'cancelled'], [d(7), 'cancelled'],
    ]);
    const refunded = await prisma.payment.findMany({ where: { booking: { seriesId: fixedId, slot: { date: { gte: toDbDate(d(5)) } } } } });
    expect(refunded.length).toBeGreaterThan(0);
    expect(refunded.every((p) => p.status === 'refunded')).toBe(true);
    expect((await slotAt(6, 21)).status).toBe('available');
    expect(send).not.toHaveBeenCalled();

    const again = await adminAgent.post(`${API}/admin/booking-series/${fixedId}/stop`).send({ fromDate: d(5), refund: true });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('SERIES_STOPPED');
  });

  it('books an ongoing series up to the slots that exist, then extends it once as more are generated', async () => {
    const res = await adminAgent.post(`${API}/admin/booking-series`).send({
      groundId, startHour: 20, weekdays: ALL_DAYS, fromDate: d(1), untilDate: null, customer, payment: { type: 'full', method: 'cash' },
    }).expect(201);
    ongoingId = res.body.data.id;
    expect(res.body.data).toMatchObject({ untilDate: null, bookedThrough: d(7), totals: { bookings: 7, total: 7000, paid: 7000, due: 0 } });

    await seedSlots(8, 10);
    await prisma.slot.update({ where: { id: (await slotAt(9, 20)).id }, data: { status: 'blocked', blockReason: 'event' } });
    const booker = app.get(BookingSeriesBooker);
    expect(await booker.extend(ongoingId)).toBe(2);
    expect(await booker.extend(ongoingId)).toBe(0);
    await booker.extendOngoing();

    const series = (await adminAgent.get(`${API}/admin/booking-series/${ongoingId}`)).body.data as SeriesBody;
    expect(series).toMatchObject({ bookedThrough: d(10), skipped: [{ date: d(9), reason: 'blocked' }] });
    expect(series.bookings.map((b) => b.date)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10].map(d));
    expect(series.bookings.slice(-2).every((b) => b.status === 'confirmed' && b.due === 1000)).toBe(true);
    expect(await prisma.booking.count({ where: { seriesId: ongoingId, slot: { date: toDbDate(d(8)) } } })).toBe(1);
  });

  it('stops without a refund: payments stay, later bookings cancelled, no more extending', async () => {
    const res = await adminAgent.post(`${API}/admin/booking-series/${ongoingId}/stop`).send({ fromDate: d(7), refund: false }).expect(200);
    const body = res.body.data as SeriesBody;
    expect(body.bookings.filter((b) => b.status === 'cancelled').map((b) => b.date)).toEqual([d(7), d(8), d(10)]);
    expect(body.bookings.filter((b) => b.status === 'confirmed')).toHaveLength(6);
    const kept = await prisma.payment.findFirstOrThrow({ where: { booking: { seriesId: ongoingId, slot: { date: toDbDate(d(7)) } } } });
    expect(kept.status).toBe('succeeded');

    await seedSlots(11, 11);
    expect(await app.get(BookingSeriesBooker).extend(ongoingId)).toBe(0);
  });

  it('needs a signed-in staff member', async () => {
    const res = await request(app.getHttpServer()).post(`${API}/admin/booking-series/preview`).send({ groundId, ...fixed });
    expect(res.status).toBe(401);
    await request(app.getHttpServer()).get(`${API}/admin/booking-series/${fixedId}`).expect(401);
  });
});
