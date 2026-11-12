import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { hashPassword } from './../src/auth/password.js';
import { EmailService } from './../src/email/email.service.js';
import { StripeService } from './../src/payments/stripe.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { addDays, toDbDate, venueNow, weekdayOf, type IsoDate } from './../src/slots/venue-time.js';

const API = '/api/v1';
const SLOTS = `${API}/admin/slots`;
const DOMAIN = '@closed-days.test';
const PREFIX = 'E2E Closed days';
const PHONE = '0177400000';
const STORED_PHONE = '+880177400000';
const password = 'e2e-password-123';
const admin = { email: `admin${DOMAIN}`, password };

const nextDay = (day: string): IsoDate => {
  let date = addDays(venueNow().date, 2);
  while (weekdayOf(date) !== day) date = addDays(date, 1);
  return date;
};
/** Closed for a `weekends` ground. */
const sunday = nextDay('sun');
/** Open for a `weekends` ground. */
const friday = nextDay('fri');

describe('Booking a closed day (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const cleanup = async () => {
    const grounds = await prisma.ground.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
    const ids = grounds.map((g) => g.id);
    await prisma.bookingEvent.deleteMany({ where: { booking: { groundId: { in: ids } } } });
    await prisma.payment.deleteMany({ where: { booking: { groundId: { in: ids } } } });
    await prisma.bookingSlot.deleteMany({ where: { booking: { groundId: { in: ids } } } });
    await prisma.booking.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { phone: { startsWith: STORED_PHONE } } });
    await prisma.slotEvent.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.slot.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.ground.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await cleanup();
    await prisma.user.create({ data: { email: admin.email, name: 'Admin', role: 'admin', passwordHash: await hashPassword(password) } });
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeService).useValue({ createCheckoutSession: vi.fn(async () => ({ id: 'cs_closed_days', url: 'https://stripe.test/cs' })) })
      .overrideProvider(EmailService).useValue({ send: vi.fn(async () => true) })
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterEach(() => app.close());

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  const signIn = async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post(`${API}/admin/auth/login`).send(admin).expect(200);
    return agent;
  };
  type Agent = Awaited<ReturnType<typeof signIn>>;

  const groundWithSlots = async (name: string, data: object, dates: IsoDate[]) => {
    const ground = await prisma.ground.create({
      data: { name: `${PREFIX} ${name}`, sport: 'football', hourlyPrice: 1000, openingHour: 8, closingHour: 12, ...data },
    });
    await prisma.slot.createMany({ data: dates.map((date) => ({ groundId: ground.id, date: toDbDate(date), startHour: 9, price: 1000 })) });
    return ground.id;
  };
  const slotOn = (groundId: string, date: IsoDate) =>
    prisma.slot.findUniqueOrThrow({ where: { groundId_date_startHour_startMinute: { groundId, date: toDbDate(date), startHour: 9, startMinute: 0 } } });
  const closeOnSundays = (groundId: string) => prisma.ground.update({ where: { id: groundId }, data: { availableDays: 'weekends' } });

  const checkout = (groundId: string, date: IsoDate, phoneEnd: string) =>
    request(app.getHttpServer()).post(`${API}/checkout`).send({
      groundId, date, startHour: 9, customerName: 'Rakib Hasan', customerEmail: 'r@x.test', customerPhone: `${PHONE}${phoneEnd}`, paymentMethod: 'card',
    });
  const staffBook = (agent: Agent, slotId: string, phoneEnd: string, payment: object = { type: 'none' }) =>
    agent.post(`${API}/admin/bookings`).send({
      slotId, customer: { name: 'Walk In', phone: `${PHONE}${phoneEnd}`, email: 'walk@in.test' }, payment,
    });

  /** The row is free, and still can't be booked by a customer or by staff. */
  const expectRefused = async (agent: Agent, groundId: string) => {
    const slot = await slotOn(groundId, sunday);
    expect(slot.status).toBe('available');
    const customer = await checkout(groundId, sunday, '8').expect(400);
    expect(customer.body.code).toBe('GROUND_CLOSED');
    const staff = await staffBook(agent, slot.id, '9').expect(400);
    expect(staff.body.code).toBe('GROUND_CLOSED');
    expect((await slotOn(groundId, sunday)).status).toBe('available');
    expect(await prisma.booking.count({ where: { slotId: slot.id, liveSlotId: { not: null } } })).toBe(0);
  };

  describe('refuses a new booking', () => {
    it('on a free row that was never booked', async () => {
      const agent = await signIn();
      await expectRefused(agent, await groundWithSlots('Free', { availableDays: 'weekends' }, [sunday]));
    });

    it('after a cancelled booking freed the row', async () => {
      const agent = await signIn();
      const groundId = await groundWithSlots('Cancelled', {}, [sunday]);
      const { id: slotId } = await slotOn(groundId, sunday);
      const booked = await staffBook(agent, slotId, '1').expect(201);
      await closeOnSundays(groundId);
      await agent.post(`${API}/admin/bookings/${booked.body.data.id}/cancel`).send({ reason: 'Customer asked', refund: false }).expect(200);
      await expectRefused(agent, groundId);
    });

    it('after an unblock freed the row', async () => {
      const agent = await signIn();
      const groundId = await groundWithSlots('Unblocked', {}, [sunday]);
      const { id: slotId } = await slotOn(groundId, sunday);
      await agent.post(`${SLOTS}/${slotId}/block`).send({ reason: 'maintenance' }).expect(200);
      await closeOnSundays(groundId);
      await agent.post(`${SLOTS}/${slotId}/unblock`).expect(200);
      await expectRefused(agent, groundId);
    });
  });

  describe('leaves alone', () => {
    it('the open days of the same ground', async () => {
      const groundId = await groundWithSlots('Open day', { availableDays: 'weekends' }, [friday]);
      await checkout(groundId, friday, '2').expect(201);
      expect((await slotOn(groundId, friday)).status).toBe('held');
    });

    it('how each path treats an inactive ground: staff book its open days, customers get a 404', async () => {
      const agent = await signIn();
      const groundId = await groundWithSlots('Inactive', { isActive: false, availableDays: 'weekends' }, [friday]);
      await checkout(groundId, friday, '3').expect(404);
      await staffBook(agent, (await slotOn(groundId, friday)).id, '3').expect(201);
    });

    it('an existing booking whose day has closed: staff can confirm it and take payment, and cancelling refunds it', async () => {
      const agent = await signIn();
      const groundId = await groundWithSlots('Honoured', {}, [sunday]);
      const { id: slotId } = await slotOn(groundId, sunday);
      const booked = await staffBook(agent, slotId, '4').expect(201);
      const bookingUrl = `${API}/admin/bookings/${booked.body.data.id}`;
      await closeOnSundays(groundId);
      expect((await slotOn(groundId, sunday)).status).toBe('booked');

      const confirmed = await agent.post(`${bookingUrl}/confirm`).send({}).expect(200);
      expect(confirmed.body.data).toMatchObject({ status: 'confirmed', paymentStatus: 'unpaid' });
      const paid = await agent.post(`${bookingUrl}/payments`).send({ amount: 1000, method: 'cash' }).expect(201);
      expect(paid.body.data).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
      expect((await slotOn(groundId, sunday)).status).toBe('booked');

      const res = await agent.post(`${bookingUrl}/cancel`).send({ reason: 'Customer asked', refund: true }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'cancelled', paymentStatus: 'refunded' });
    });
  });

  describe('GET /admin/slots?openDaysOnly', () => {
    const availableOn = (agent: Agent, groundId: string, date: IsoDate, extra: object) =>
      agent.get(SLOTS).query({ groundId, date, status: 'available', ...extra });

    it('hides closed days from the booking form, and only when asked', async () => {
      const agent = await signIn();
      const groundId = await groundWithSlots('Form', { availableDays: 'weekends' }, [sunday, friday]);

      const closed = await availableOn(agent, groundId, sunday, { openDaysOnly: 'true' }).expect(200);
      expect(closed.body.data).toMatchObject({ data: [], total: 0, stats: { available: 1 } });
      const open = await availableOn(agent, groundId, friday, { openDaysOnly: 'true' }).expect(200);
      expect(open.body.data.total).toBe(1);
      const unfiltered = await availableOn(agent, groundId, sunday, {}).expect(200);
      expect(unfiltered.body.data.total).toBe(1);
    });

    it('needs a ground', async () => {
      const agent = await signIn();
      await agent.get(SLOTS).query({ date: sunday, openDaysOnly: 'true' }).expect(400);
    });
  });
});
