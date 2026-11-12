import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { hashPassword } from './../src/auth/password.js';
import { bookingToken } from './../src/bookings/booking-rules.js';
import { EmailService } from './../src/email/email.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { addDays, toDbDate, venueNow } from './../src/slots/venue-time.js';
import { signInCustomer } from './sign-in-customer.js';

const API = '/api/v1';
const DOMAIN = '@slot-90.test';
const PREFIX = 'E2E Slot 90';
/** Every customer phone in this file starts with this, for cleanup. */
const PHONE = '+88017990095';
const password = 'e2e-password-123';
const admin = { email: `admin${DOMAIN}`, password };
const manager = { email: `manager${DOMAIN}`, password };
const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_TIMES = ['15:00', '16:30', '18:00', '19:30', '21:00', '22:30'];

const today = venueNow().date;
const d = (n: number) => addDays(today, n);

type PublicSlot = { id: string; startTime: string; available: boolean } & Record<string, unknown>;

/** 90-minute slots end to end: generation, the portal, staff, the cutoff, repeat bookings and blocks. */
describe('90-minute slots (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let groundId: string;
  let adminAgent: ReturnType<typeof request.agent>;
  let managerAgent: ReturnType<typeof request.agent>;
  const send = vi.fn(async () => true);

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

  /** 15:00–24:00, peak from 18:00 unless `closingHour` is earlier. */
  const newGround = async (name: string, slotDurationMinutes: number, closingHour = 24) => (await prisma.ground.create({
    data: {
      name: `${PREFIX} ${name}`, sport: 'football', hourlyPrice: 1000, openingHour: 15, closingHour, slotDurationMinutes,
      ...(closingHour > 18 && { peakPrice: 1500, peakRanges: [{ fromHour: 18, toHour: closingHour }] }),
    },
  })).id;

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
    groundId = await newGround('Main', 90);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EmailService).useValue({ send }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    // One sign-in per role for the whole file: the login endpoint is rate limited.
    adminAgent = request.agent(app.getHttpServer());
    await adminAgent.post(`${API}/admin/auth/login`).send(admin).expect(200);
    managerAgent = request.agent(app.getHttpServer());
    await managerAgent.post(`${API}/admin/auth/login`).send(manager).expect(200);
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await prisma.$disconnect();
  });

  const http = () => request(app.getHttpServer());
  const publicSlots = async (id: string, date: string): Promise<PublicSlot[]> =>
    (await http().get(`${API}/grounds/${id}/slots`).query({ date }).expect(200)).body.data;
  /** A signed-in customer (one phone each, for the checkout rate limit) books cash at the venue. */
  const cashCheckout = async (id: string, date: string, hour: number, minute: number, phoneEnd: string, status = 201) => {
    const customerPhone = `017990095${phoneEnd}`;
    const customer = await signInCustomer(app, customerPhone);
    return customer.post(`${API}/checkout`)
      .send({ groundId: id, date, hour, minute, customerName: 'Nadia Islam', customerPhone, paymentMethod: 'cash' }).expect(status);
  };
  const detail = async (id: string) => (await managerAgent.get(`${API}/admin/bookings/${id}`).expect(200)).body.data;

  it('generates slots every 90 minutes from opening, on the half hour, priced per half hour', async () => {
    const res = await adminAgent.post(`${API}/admin/slots/generate`).send({ groundId, fromDate: d(2), toDate: d(4) }).expect(200);
    expect(res.body.data).toMatchObject({ generated: 18, slotsPerDay: 6 });
    const rows = await prisma.slot.findMany({ where: { groundId, date: toDbDate(d(2)) }, orderBy: [{ startHour: 'asc' }, { startMinute: 'asc' }] });
    // Peak from 18:00: 16:30–18:00 is all off-peak (1.5 × 1000), 18:00 on all peak (1.5 × 1500).
    expect(rows.map((s) => [s.startHour, s.startMinute, s.durationMinutes, s.price])).toEqual([
      [15, 0, 90, 1500], [16, 30, 90, 1500], [18, 0, 90, 2250], [19, 30, 90, 2250], [21, 0, 90, 2250], [22, 30, 90, 2250],
    ]);
  });

  it('public and admin slots carry the minute and HH:MM times', async () => {
    const slots = await publicSlots(groundId, d(2));
    expect(slots.map((s) => s.startTime)).toEqual(DAY_TIMES);
    expect(slots[1]).toEqual({
      id: expect.any(String), date: d(2), startHour: 16, startMinute: 30, endHour: 18, endMinute: 0, startTime: '16:30', endTime: '18:00',
      price: 1500, isPeak: false, available: true,
    });
    expect(slots[5]).toMatchObject({ startHour: 22, startMinute: 30, endHour: 24, endMinute: 0, endTime: '24:00', isPeak: true });
    const listed = await managerAgent.get(`${API}/admin/slots`).query({ groundId, date: d(2) }).expect(200);
    expect(listed.body.data.data[1]).toMatchObject({ startHour: 16, startMinute: 30, endHour: 18, startTime: '16:30', endTime: '18:00', durationMinutes: 90 });
  });

  it('a signed-in customer books 16:30 with cash; staff confirm and collect it', async () => {
    // Whole hours don't exist on this ground.
    expect((await cashCheckout(groundId, d(2), 16, 0, '00', 409)).body.code).toBe('SLOT_NOT_AVAILABLE');
    const res = await cashCheckout(groundId, d(2), 16, 30, '01');
    const id = res.body.data.bookingId as string;
    const booked = await detail(id);
    expect(booked).toMatchObject({
      status: 'pending', payAtVenue: true, amount: 1500,
      slot: { date: d(2), startHour: 16, startMinute: 30, endHour: 18, endMinute: 0, startTime: '16:30', endTime: '18:00' },
    });
    const own = await http().get(`${API}/bookings/${id}`).query({ token: bookingToken(id) }).expect(200);
    expect(own.body.data.slot).toEqual({ date: d(2), startHour: 16, startMinute: 30, endHour: 18, endMinute: 0, startTime: '16:30', endTime: '18:00' });
    expect((await publicSlots(groundId, d(2)))[1]!.available).toBe(false);

    await managerAgent.post(`${API}/admin/bookings/${id}/confirm`).send({ notifyCustomer: false }).expect(200);
    await managerAgent.post(`${API}/admin/bookings/${id}/payments`).send({ amount: booked.total, method: 'cash' }).expect(201);
    expect(await detail(id)).toMatchObject({ status: 'confirmed', paymentStatus: 'paid', due: 0 });
  });

  it('the customer cancel cutoff counts from the half hour', async () => {
    // Its own ground, so moving slots next to now can't clash with the slots above.
    const lateId = await newGround('Late', 90);
    await prisma.slot.createMany({
      data: [16, 19].map((startHour) => ({ groundId: lateId, date: toDbDate(d(5)), startHour, startMinute: 30, durationMinutes: 90, price: 1500 })),
    });
    const outside = (await cashCheckout(lateId, d(5), 16, 30, '10')).body.data.bookingId as string;
    const inside = (await cashCheckout(lateId, d(5), 19, 30, '11')).body.data.bookingId as string;

    const settings = await prisma.slotSettings.findUnique({ where: { id: 1 } });
    const cutoff = (settings?.cancellationCutoffHours ?? 2) * 60;
    const now = venueNow();
    // The first half hour more than the cutoff away (cancellable), and the one an hour before it (inside).
    const lead = now.minutes + cutoff;
    const first = lead - (lead % 60) + 30 > lead ? lead - (lead % 60) + 30 : lead - (lead % 60) + 90;
    const moveTo = async (bookingId: string, total: number) => {
      const { slotId } = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
      const m = total % 1440;
      await prisma.slot.update({
        where: { id: slotId }, data: { date: toDbDate(addDays(now.date, Math.floor(total / 1440))), startHour: Math.floor(m / 60), startMinute: m % 60 },
      });
    };
    await moveTo(outside, first);
    await moveTo(inside, first - 60);

    const view = async (id: string) => (await http().get(`${API}/bookings/${id}`).query({ token: bookingToken(id) }).expect(200)).body.data;
    expect((await view(outside)).canCancel).toBe(true);
    expect((await view(inside)).canCancel).toBe(false);
    const refused = await http().post(`${API}/bookings/${inside}/cancel`).query({ token: bookingToken(inside) }).expect(400);
    expect(refused.body.code).toBe('CANCELLATION_WINDOW_PASSED');
    const done = await http().post(`${API}/bookings/${outside}/cancel`).query({ token: bookingToken(outside) }).expect(200);
    expect(done.body.data.status).toBe('cancelled');
  });

  it('a repeat booking at 19:30 matches the minute', async () => {
    const range = { groundId, weekdays: ALL_DAYS, fromDate: d(2), untilDate: d(4) };
    const wrong = await managerAgent.post(`${API}/admin/booking-series/preview`).send({ ...range, startHour: 19 }).expect(200);
    expect(wrong.body.data.bookableCount).toBe(0);
    expect(wrong.body.data.dates.map((x: { reason: string }) => x.reason)).toEqual(['no_slot', 'no_slot', 'no_slot']);
    const preview = await managerAgent.post(`${API}/admin/booking-series/preview`).send({ ...range, startHour: 19, startMinute: 30 }).expect(200);
    expect(preview.body.data).toMatchObject({ bookableCount: 3, total: 6750 });

    const res = await managerAgent.post(`${API}/admin/booking-series`).send({
      ...range, startHour: 19, startMinute: 30, customer: { name: 'Evening Club', phone: '01799009520' }, payment: { type: 'none' },
    }).expect(201);
    expect(res.body.data).toMatchObject({
      startHour: 19, startMinute: 30, startTime: '19:30', endHour: 21, endMinute: 0, endTime: '21:00', totals: { bookings: 3, total: 6750 },
    });
    expect((await prisma.bookingSeries.findUniqueOrThrow({ where: { id: res.body.data.id } })).startMinute).toBe(30);
    const first = await detail(res.body.data.bookings[0].id);
    expect(first.slot).toMatchObject({ date: d(2), startTime: '19:30', endTime: '21:00' });
  });

  it('blocks a single :30 slot by hour and minute', async () => {
    const block = { type: 'single', groundId, date: d(4), reason: 'event' };
    // No 22:00 slot here: the minute defaults to 0.
    expect((await managerAgent.post(`${API}/admin/slots/block`).send({ ...block, startHour: 22 }).expect(404)).body.code).toBe('SLOT_NOT_FOUND');
    const bad = await managerAgent.post(`${API}/admin/slots/block`).send({ ...block, startHour: 22, startMinute: 15 }).expect(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    await managerAgent.post(`${API}/admin/slots/block`).send({ ...block, startHour: 22, startMinute: 30 }).expect(200);
    const slots = await publicSlots(groundId, d(4));
    expect(slots.map((s) => [s.startTime, s.available])).toEqual([
      ['15:00', true], ['16:30', true], ['18:00', true], ['19:30', false], ['21:00', true], ['22:30', false],
    ]);
  });

  it('switching a ground from 60 to 90 minutes replaces its free future slots', async () => {
    const switchId = await newGround('Switch', 60, 18);
    await adminAgent.post(`${API}/admin/slots/generate`).send({ groundId: switchId, fromDate: d(2), toDate: d(2) }).expect(200);
    const res = await adminAgent.patch(`${API}/admin/grounds/${switchId}`).send({ slotDurationMinutes: 90 }).expect(200);
    expect(res.body.data).toMatchObject({ slotDurationMinutes: 90, slotSync: { kept: 0 } });
    expect(res.body.data.slotSync.removed).toBeGreaterThanOrEqual(3);
    expect((await publicSlots(switchId, d(2))).map((s) => [s.startTime, s.endTime])).toEqual([['15:00', '16:30'], ['16:30', '18:00']]);
  });
});
