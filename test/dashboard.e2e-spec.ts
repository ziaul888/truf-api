import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { hashPassword } from './../src/auth/password.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { addDays, toDbDate, venueNow } from './../src/slots/venue-time.js';

const API = '/api/v1';
const DOMAIN = '@dashboard.test';
const PREFIX = 'E2E Dashboard';
const PHONE = '+88017990030';
const password = 'e2e-password-123';

// Other e2e files share the database and today's date, so global counts are checked with ≥,
// and exact checks are scoped to this file's ground.
describe('Dashboard (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let agent: ReturnType<typeof request.agent>;
  let groundId: string;
  const ids: Record<string, string> = {};
  const now = venueNow();
  const nowHour = Math.floor(now.minutes / 60);
  const hasNext = nowHour < 23;
  const today = now.date;
  const tomorrow = addDays(today, 1);

  const cleanup = async () => {
    const grounds = await prisma.ground.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
    const groundIds = grounds.map((g) => g.id);
    await prisma.bookingEvent.deleteMany({ where: { booking: { groundId: { in: groundIds } } } });
    await prisma.payment.deleteMany({ where: { booking: { groundId: { in: groundIds } } } });
    await prisma.booking.deleteMany({ where: { groundId: { in: groundIds } } });
    await prisma.customer.deleteMany({ where: { phone: { startsWith: PHONE } } });
    await prisma.slot.deleteMany({ where: { groundId: { in: groundIds } } });
    await prisma.ground.deleteMany({ where: { id: { in: groundIds } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  };

  /**
   * Today: every hour has a slot. O (overdue: due date yesterday) is playing now; N is next,
   * starting within the hour, part paid. Tomorrow: T (due today), P (pending staff booking), C (a
   * card checkout still in Stripe, slot held), X (an abandoned checkout).
   */
  async function seed() {
    await prisma.user.create({ data: { email: `manager${DOMAIN}`, name: 'Manager', role: 'manager', passwordHash: await hashPassword(password) } });
    groundId = (await prisma.ground.create({
      data: { name: `${PREFIX} Main`, sport: 'football', hourlyPrice: 1000, openingHour: 0, closingHour: 24 },
    })).id;
    const customer = await prisma.customer.create({ data: { name: 'Dash Customer', phone: `${PHONE}01`, email: 'd@dashboard.test' } });
    await prisma.slot.createMany({ data: Array.from({ length: 24 }, (_, startHour) => ({ groundId, date: toDbDate(today), startHour, price: 1000 })) });
    const book = async (key: string, date: string, hour: number, slotStatus: 'booked' | 'held' | 'available', data: object) => {
      const slot = await prisma.slot.upsert({
        where: { groundId_date_startHour: { groundId, date: toDbDate(date), startHour: hour } },
        create: { groundId, date: toDbDate(date), startHour: hour, price: 1000, status: slotStatus },
        update: { status: slotStatus },
      });
      const live = slotStatus === 'available' ? {} : { liveSlotId: slot.id };
      ids[key] = (await prisma.booking.create({
        data: {
          bookingNumber: `CT-DSH${key}`, groundId, slotId: slot.id, customerId: customer.id, contactName: `Customer ${key}`,
          contactEmail: customer.email, contactPhone: customer.phone!, amount: 1000, total: 1000, ...live, ...data,
        } as never,
      })).id;
    };
    await book('O', today, nowHour, 'booked', { source: 'staff', status: 'confirmed', dueDate: toDbDate(addDays(today, -1)) });
    if (hasNext) await book('N', today, nowHour + 1, 'booked', { source: 'staff', status: 'confirmed', amount: 2000, total: 2000, paymentStatus: 'partial' });
    await book('T', tomorrow, 10, 'booked', { source: 'staff', status: 'confirmed', paymentStatus: 'partial', dueDate: toDbDate(today) });
    await book('P', tomorrow, 11, 'booked', { source: 'staff', status: 'pending' });
    await book('C', tomorrow, 12, 'held', { source: 'portal', status: 'pending', serviceFee: 5000, total: 6000 });
    await book('X', tomorrow, 13, 'available', { source: 'portal', status: 'cancelled' });
    await prisma.payment.createMany({
      data: [
        { bookingId: ids.T!, method: 'cash', amount: 300, currency: 'bdt', status: 'succeeded' },
        ...(hasNext ? [{ bookingId: ids.N!, method: 'cash' as const, amount: 500, currency: 'bdt', status: 'succeeded' as const }] : []),
      ],
    });
    // Dated in the future so they sit at the top of the feed whatever other tests write.
    const later = new Date(Date.now() + 86_400_000);
    await prisma.bookingEvent.createMany({
      data: [
        { bookingId: ids.O!, type: 'payment_received', detail: 'Paid 1000 by cash', createdAt: later },
        { bookingId: ids.X!, type: 'created', detail: 'Checkout started on the portal', createdAt: new Date(later.getTime() + 1000) },
      ],
    });
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await cleanup();
    await seed();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    agent = request.agent(app.getHttpServer());
    await agent.post(`${API}/admin/auth/login`).send({ email: `manager${DOMAIN}`, password }).expect(200);
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await prisma.$disconnect();
  });

  const bookingIds = async (due: string) => {
    const res = await agent.get(`${API}/admin/bookings`).query({ groundId, due, limit: 100 }).expect(200);
    return res.body.data.data.map((b: { id: string }) => b.id).sort();
  };

  it('the bookings list filters by money due; card checkouts in Stripe are never due', async () => {
    expect(await bookingIds('overdue')).toEqual([ids.O]);
    expect(await bookingIds('today')).toEqual([ids.T]);
    expect(await bookingIds('any')).toEqual([ids.O, ids.T, ids.P, ...(hasNext ? [ids.N] : [])].sort());
    const bad = await agent.get(`${API}/admin/bookings`).query({ due: 'soon' }).expect(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
  });

  it('needs attention: counts at least this file\'s bookings', async () => {
    const res = await agent.get(`${API}/admin/dashboard/attention`).expect(200);
    const a = res.body.data;
    expect(a.overdue.count).toBeGreaterThanOrEqual(1);
    expect(a.overdue.amount).toBeGreaterThanOrEqual(1000);
    expect(a.dueToday.count).toBeGreaterThanOrEqual(1);
    expect(a.dueToday.amount).toBeGreaterThanOrEqual(700);
    expect(a.toConfirm.count).toBeGreaterThanOrEqual(1);
    expect(a.payingNow.count).toBeGreaterThanOrEqual(1);
    expect(a.startingSoon).toMatchObject({ withinMinutes: 60 });
    if (hasNext) expect(a.startingSoon.count).toBeGreaterThanOrEqual(1);
  });

  it('today by ground: slot counts, who is on now and who is next', async () => {
    const res = await agent.get(`${API}/admin/dashboard/today`).expect(200);
    expect(res.body.data).toMatchObject({ date: today, nowHour });
    const g = res.body.data.grounds.find((x: { groundId: string }) => x.groundId === groundId);
    expect(g).toMatchObject({
      groundName: `${PREFIX} Main`, closedReason: null,
      slots: { total: 24, booked: hasNext ? 2 : 1, held: 0, blocked: 0 },
      bookedHours: hasNext ? 2 : 1, revenueToday: hasNext ? 800 : 300,
      current: { bookingId: ids.O, customerName: 'Customer O', startHour: nowHour, endHour: nowHour + 1 },
    });
    expect(g.next).toEqual(hasNext ? { bookingId: ids.N, bookingNumber: 'CT-DSHN', customerName: 'Customer N', startHour: nowHour + 1, endHour: nowHour + 2, due: 1500 } : null);
    expect(g.timeline).toHaveLength(24);
  });

  it('recent activity: newest first with the booking, without abandoned checkouts', async () => {
    const res = await agent.get(`${API}/admin/booking-events`).query({ type: ['payment_received', 'created'], limit: 5 }).expect(200);
    expect(res.body.data.data[0]).toMatchObject({
      type: 'payment_received', detail: 'Paid 1000 by cash', user: null,
      booking: { id: ids.O, bookingNumber: 'CT-DSHO', customerName: 'Customer O', groundName: `${PREFIX} Main` },
    });
    expect(res.body.data.data.some((e: { booking: { id: string } }) => e.booking.id === ids.X)).toBe(false);
    expect(res.body.data).toMatchObject({ page: 1, limit: 5 });
    await agent.get(`${API}/admin/booking-events`).query({ limit: 51 }).expect(400);
    await agent.get(`${API}/admin/booking-events`).query({ type: 'nope' }).expect(400);
  });

  it('stats trends are a number or null', async () => {
    const res = await agent.get(`${API}/admin/dashboard/stats`).expect(200);
    for (const key of ['todayRevenueTrend', 'todayBookingsTrend', 'totalCustomersTrend', 'activeGroundsTrend']) {
      expect(res.body.data[key] === null || typeof res.body.data[key] === 'number').toBe(true);
    }
  });

  it('needs a staff session', async () => {
    for (const path of ['dashboard/attention', 'dashboard/today', 'booking-events']) {
      await request(app.getHttpServer()).get(`${API}/admin/${path}`).expect(401);
    }
  });
});
