import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { hashPassword } from './../src/auth/password.js';
import { EmailService } from './../src/email/email.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { addDays, toDbDate, venueNow } from './../src/slots/venue-time.js';

const API = '/api/v1';
const DOMAIN = '@walk-in.test';
const PREFIX = 'E2E Walk In';
/** Every customer phone in this file starts with this, for cleanup. */
const PHONE = '+8801799200';
const admin = { email: `admin${DOMAIN}`, password: 'e2e-password-123' };

const now = venueNow();
const hourNow = Math.floor(now.minutes / 60);
const customer = { name: 'Walk In', phone: '01799200001', email: 'walkin@example.com' };

describe('Walk-in bookings (e2e)', () => {
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

  beforeAll(async () => {
    prisma = new PrismaService();
    await cleanup();
    await prisma.user.create({ data: { email: admin.email, name: 'Admin', role: 'admin', passwordHash: await hashPassword(admin.password) } });
    groundId = (await prisma.ground.create({
      data: { name: `${PREFIX} Main`, sport: 'football', hourlyPrice: 1000, openingHour: 0, closingHour: 24 },
    })).id;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailService).useValue({ send: vi.fn(async () => true) })
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await prisma.$disconnect();
  });

  const signIn = async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post(`${API}/admin/auth/login`).send(admin).expect(200);
    return agent;
  };
  const book = async (slotId: string) => (await signIn()).post(`${API}/admin/bookings`).send({
    slotId, customer, payment: { type: 'full', method: 'cash' },
  });

  it('takes a walk-in on the slot running now, with the cash recorded', async () => {
    const slot = await prisma.slot.create({ data: { groundId, date: toDbDate(now.date), startHour: hourNow, price: 1000 } });
    const res = await book(slot.id);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
    expect(await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } })).toMatchObject({ status: 'booked' });
  });

  it('refuses a slot that has ended, and leaves it free', async () => {
    const slot = await prisma.slot.create({ data: { groundId, date: toDbDate(addDays(now.date, -1)), startHour: 22, price: 1000 } });
    const res = await book(slot.id);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SLOT_IN_PAST');
    expect(await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } })).toMatchObject({ status: 'available' });
  });
});
