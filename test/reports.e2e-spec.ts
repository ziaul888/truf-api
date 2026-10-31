import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { hashPassword } from './../src/auth/password.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { toDbDate } from './../src/slots/venue-time.js';

const API = '/api/v1';
const REPORTS = `${API}/admin/reports`;
const DOMAIN = '@reports.test';
const PREFIX = 'E2E Reports';
const PHONE = '+88017990020';
const password = 'e2e-password-123';
// A month in the past that no other test touches, so totals are exact while e2e files run in parallel.
const MARCH = { from: '2025-03-01', to: '2025-03-31' };

describe('Reports (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let groundId: string;

  const cleanup = async () => {
    const grounds = await prisma.ground.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
    const ids = grounds.map((g) => g.id);
    await prisma.payment.deleteMany({ where: { booking: { groundId: { in: ids } } } });
    await prisma.booking.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { phone: { startsWith: PHONE } } });
    await prisma.slot.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.ground.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  };

  /**
   * On 10 Mar 2025, four 1-hour bookings:
   * - 08:00 completed, ৳10 cash paid at 00:30 Dhaka time on 10 Mar (still 9 Mar in UTC)
   * - 09:00 cancelled, ৳20 card paid in February, refunded on 12 Mar
   * - 10:00 an abandoned card checkout (never counted)
   * - 11:00 confirmed, unpaid
   * Plus a blocked slot on 11 Mar.
   */
  async function seed() {
    const passwordHash = await hashPassword(password);
    await prisma.user.createMany({
      data: [
        { email: `admin${DOMAIN}`, name: 'Admin', role: 'admin', passwordHash },
        { email: `manager${DOMAIN}`, name: 'Manager', role: 'manager', passwordHash },
      ],
    });
    groundId = (await prisma.ground.create({
      data: { name: `${PREFIX} Main`, sport: 'football', hourlyPrice: 1000, openingHour: 8, closingHour: 12 },
    })).id;
    const customer = await prisma.customer.create({
      data: { name: 'Report, Customer', phone: `${PHONE}01`, email: 'r@reports.test', createdAt: new Date('2025-03-05T06:00:00Z') },
    });
    const slot = (date: string, startHour: number, status: 'available' | 'booked' | 'blocked') =>
      prisma.slot.create({ data: { groundId, date: toDbDate(date), startHour, price: 1000, status } });
    const [s8, s9, s10, s11] = await Promise.all([
      slot('2025-03-10', 8, 'booked'), slot('2025-03-10', 9, 'available'), slot('2025-03-10', 10, 'available'), slot('2025-03-10', 11, 'booked'),
      slot('2025-03-11', 8, 'blocked'),
    ]);
    const base = { groundId, customerId: customer.id, contactName: customer.name, contactEmail: customer.email, contactPhone: customer.phone! };
    const book = (n: string, data: object) => prisma.booking.create({ data: { ...base, bookingNumber: `CT-RPT${n}`, ...data } as never });
    const b8 = await book('8', { source: 'staff', slotId: s8!.id, liveSlotId: s8!.id, status: 'completed', paymentStatus: 'paid', amount: 1000, total: 1000, confirmedAt: new Date() });
    const b9 = await book('9', { source: 'staff', slotId: s9!.id, status: 'cancelled', paymentStatus: 'refunded', amount: 2000, total: 2000, confirmedAt: new Date() });
    await book('A', { source: 'portal', slotId: s10!.id, status: 'cancelled', amount: 1000, serviceFee: 5000, total: 6000 });
    await book('B', { source: 'staff', slotId: s11!.id, liveSlotId: s11!.id, status: 'confirmed', amount: 3000, total: 3000, confirmedAt: new Date() });
    await prisma.payment.createMany({
      data: [
        { bookingId: b8.id, method: 'cash', amount: 1000, currency: 'bdt', status: 'succeeded', createdAt: new Date('2025-03-09T18:30:00Z') },
        {
          bookingId: b9.id, method: 'card', amount: 2000, currency: 'bdt', status: 'refunded',
          createdAt: new Date('2025-02-20T06:00:00Z'), refundedAt: new Date('2025-03-12T06:00:00Z'),
        },
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
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await prisma.$disconnect();
  });

  // One session per role: logins are rate-limited to 5 a minute.
  const agents = new Map<string, ReturnType<typeof request.agent>>();
  async function signIn(role: 'admin' | 'manager') {
    if (!agents.has(role)) {
      const agent = request.agent(app.getHttpServer());
      await agent.post(`${API}/admin/auth/login`).send({ email: `${role}${DOMAIN}`, password }).expect(200);
      agents.set(role, agent);
    }
    return agents.get(role)!;
  }

  it('summary: revenue by money date, bookings by slot date, abandoned checkouts left out', async () => {
    const res = await (await signIn('manager')).get(`${REPORTS}/summary`).query(MARCH).expect(200);
    expect(res.body.data).toEqual({
      period: MARCH, previous: { from: '2025-01-29', to: '2025-02-28' },
      revenue: -1000, revenueTrend: -150, received: 1000, refunds: 2000,
      revenueByMethod: { card: -2000, cash: 1000, bank_transfer: 0 },
      bookings: 3, bookingsTrend: null,
      avgBookingValue: 2000, avgBookingValueTrend: null,
      completionRate: 33.3, completionRateTrend: null,
      cancellationRate: 33.3,
      statusCounts: { pending: 0, confirmed: 1, completed: 1, cancelled: 1 },
    });
  });

  it('revenue over time: every day present, the 00:30 payment on 10 Mar, the refund on 12 Mar', async () => {
    const res = await (await signIn('admin')).get(`${REPORTS}/revenue`).query(MARCH).expect(200);
    const { groupBy, points } = res.body.data;
    expect(groupBy).toBe('day');
    expect(points).toHaveLength(31);
    expect(points[9]).toEqual({ period: '2025-03-10', label: '10 Mar', revenue: 1000, received: 1000, refunds: 0, bookings: 3 });
    expect(points[11]).toMatchObject({ period: '2025-03-12', revenue: -2000, refunds: 2000, bookings: 0 });
    expect(points[0]).toMatchObject({ revenue: 0, bookings: 0 });
  });

  it('bookings over time: Saturday weeks', async () => {
    const res = await (await signIn('admin')).get(`${REPORTS}/bookings`).query({ ...MARCH, groupBy: 'week' }).expect(200);
    const week = res.body.data.points.find((p: { period: string }) => p.period === '2025-03-08');
    expect(week).toEqual({ period: '2025-03-08', label: '8 – 14 Mar', pending: 0, confirmed: 1, completed: 1, cancelled: 1, total: 3 });
    expect(res.body.data.points[0]).toMatchObject({ period: '2025-03-01', label: '1 – 7 Mar', total: 0 });
  });

  it('grounds: revenue, bookings and utilization (blocked slots are not available hours)', async () => {
    const res = await (await signIn('admin')).get(`${REPORTS}/grounds`).query(MARCH).expect(200);
    expect(res.body.data.find((g: { groundId: string }) => g.groundId === groundId)).toEqual({
      groundId, groundName: `${PREFIX} Main`, isActive: true, revenue: -1000, bookings: 3, cancelled: 1,
      hoursBooked: 2, hoursAvailable: 4, utilization: 50,
    });
  });

  it('an empty range gives zeros and null trends', async () => {
    const res = await (await signIn('admin')).get(`${REPORTS}/summary`).query({ from: '2024-06-01', to: '2024-06-07' }).expect(200);
    expect(res.body.data).toMatchObject({ revenue: 0, revenueTrend: null, bookings: 0, completionRate: null, cancellationRate: 0 });
  });

  describe('export', () => {
    it('bookings CSV: BOM, attachment, one row per counted booking', async () => {
      const res = await (await signIn('admin')).get(`${REPORTS}/export`).query({ type: 'bookings', ...MARCH }).buffer(true).expect(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe('attachment; filename="bookings-2025-03-01-to-2025-03-31.csv"');
      expect(res.text.startsWith('﻿Booking #,Customer,Phone,Ground,Date,')).toBe(true);
      const rows = res.text.trim().split('\r\n').slice(1).filter((line) => line.includes('CT-RPT'));
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatch(/^CT-RPT8,"Report, Customer",\+8801799002001,E2E Reports Main,2025-03-10,08:00,09:00,10\.00,0\.00,10\.00,10\.00,0\.00,completed,paid,staff,/);
    });

    it('revenue CSV by day', async () => {
      const res = await (await signIn('admin')).get(`${REPORTS}/export`).query({ type: 'revenue', ...MARCH, groupBy: 'day' }).buffer(true).expect(200);
      const lines = res.text.replace('﻿', '').trim().split('\r\n');
      expect(lines[0]).toBe('Period start,Period end,Received,Refunds,Net revenue,Card,Cash,Bank transfer,Bookings');
      expect(lines).toHaveLength(32);
      expect(lines[10]).toBe('2025-03-10,2025-03-10,10.00,0.00,10.00,0.00,10.00,0.00,3');
      expect(lines[12]).toBe('2025-03-12,2025-03-12,0.00,20.00,-20.00,-20.00,0.00,0.00,0');
    });

    it('customers CSV, filtered by when they joined', async () => {
      const res = await (await signIn('admin')).get(`${REPORTS}/export`).query({ type: 'customers', ...MARCH }).buffer(true).expect(200);
      const lines = res.text.replace('﻿', '').trim().split('\r\n');
      expect(lines[0]).toBe('Name,Phone,Email,Customer since,Bookings,Total spent,Last booking,Due amount,Tag');
      expect(lines.slice(1)).toEqual(['"Report, Customer",+8801799002001,r@reports.test,2025-03-05,2,10.00,2025-03-10,30.00,new']);
    });

    it('errors come back as JSON', async () => {
      const agent = await signIn('admin');
      const month = await agent.get(`${REPORTS}/export`).query({ type: 'revenue', ...MARCH, groupBy: 'month' }).expect(400);
      expect(month.body).toMatchObject({ success: false, code: 'VALIDATION_FAILED' });
      const noRange = await agent.get(`${REPORTS}/export`).query({ type: 'bookings' }).expect(400);
      expect(noRange.body.code).toBe('VALIDATION_FAILED');
    });
  });

  it('validates the range and needs a staff session', async () => {
    const agent = await signIn('admin');
    expect((await agent.get(`${REPORTS}/summary`).query({ from: '2025-03-01' }).expect(400)).body.code).toBe('VALIDATION_FAILED');
    expect((await agent.get(`${REPORTS}/summary`).query({ from: '2025-03-31', to: '2025-03-01' }).expect(400)).body.code).toBe('VALIDATION_FAILED');
    expect((await agent.get(`${REPORTS}/revenue`).query({ from: '2024-01-01', to: '2025-03-01' }).expect(400)).body.code).toBe('RANGE_TOO_LONG');
    await request(app.getHttpServer()).get(`${REPORTS}/summary`).query(MARCH).expect(401);
  });
});
