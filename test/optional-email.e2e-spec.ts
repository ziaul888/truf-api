import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { hashPassword } from './../src/auth/password.js';
import { bookingToken } from './../src/bookings/booking-rules.js';
import { EmailService } from './../src/email/email.service.js';
import { StripeService } from './../src/payments/stripe.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { addDays, toDbDate, venueNow } from './../src/slots/venue-time.js';
import { signInCustomer } from './sign-in-customer.js';

const API = '/api/v1';
const DOMAIN = '@optional-email.test';
const PREFIX = 'E2E Optional Email';
/** Every customer phone in this file starts with this, for cleanup. */
const PHONE = '+8801799300';
const LOCAL = '01799300';
const admin = { email: `admin${DOMAIN}`, password: 'e2e-password-123' };

const date = addDays(venueNow().date, 2);

const stripe = {
  createCheckoutSession: vi.fn(async ({ bookingId }: { bookingId: string }) => ({ id: `cs_${bookingId}`, url: `https://stripe.test/${bookingId}` })),
  openSessionUrl: vi.fn(async () => null), expireSession: vi.fn(async () => undefined),
};
/** Mocked, so no real email goes out; customer sends are checked by the `kind` it is called with. */
const email = { send: vi.fn(async () => true) };
const CUSTOMER_KINDS = ['booking_confirmed', 'booking_received', 'booking_cancelled', 'refund_issued', 'payment_due'];
const customerSendsFor = (bookingId: string) =>
  email.send.mock.calls.map(([m]) => m as { kind: string; bookingId?: string })
    .filter((m) => m.bookingId === bookingId && CUSTOMER_KINDS.includes(m.kind));

/** A customer may have no email: staff bookings, customer edits and signed-in checkout work without one. */
describe('Optional customer email (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let staff: ReturnType<typeof request.agent>;
  let groundId: string;

  const cleanup = async () => {
    const ids = (await prisma.ground.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((g) => g.id);
    await prisma.bookingEvent.deleteMany({ where: { booking: { groundId: { in: ids } } } });
    await prisma.payment.deleteMany({ where: { booking: { groundId: { in: ids } } } });
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
      data: { name: `${PREFIX} Main`, sport: 'football', hourlyPrice: 1000, openingHour: 8, closingHour: 20 },
    })).id;
    await prisma.slot.createMany({ data: Array.from({ length: 12 }, (_, i) => ({ groundId, date: toDbDate(date), startHour: 8 + i, price: 1000 })) });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeService).useValue(stripe).overrideProvider(EmailService).useValue(email).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    // Once per file: the staff login is limited to 5 attempts per 15 minutes.
    staff = request.agent(app.getHttpServer());
    await staff.post(`${API}/admin/auth/login`).send(admin).expect(200);
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await prisma.$disconnect();
  });

  const slotId = async (startHour: number) =>
    (await prisma.slot.findUniqueOrThrow({ where: { groundId_date_startHour: { groundId, date: toDbDate(date), startHour } } })).id;
  const staffBook = async (startHour: number, customer: object) =>
    staff.post(`${API}/admin/bookings`).send({ slotId: await slotId(startHour), customer, payment: { type: 'full', method: 'cash' } });
  const checkout = (client: ReturnType<typeof request.agent>, hour: number, phoneEnd: string, extra: object) =>
    client.post(`${API}/checkout`).send({ groundId, date, hour, customerName: 'Nadia Islam', customerPhone: `${LOCAL}${phoneEnd}`, ...extra });

  it('staff book a walk-in with no email: confirmed, no email on the booking, nothing sent to the customer', async () => {
    const res = await staffBook(8, { name: 'No Mail', phone: `${LOCAL}001`, email: '' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'confirmed', customer: { email: null }, contact: { email: null } });
    expect(customerSendsFor(res.body.data.id)).toEqual([]);
    expect(await prisma.emailLog.count({ where: { bookingId: res.body.data.id } })).toBe(0);

    const pub = await request(app.getHttpServer()).get(`${API}/bookings/${res.body.data.id}`).query({ token: bookingToken(res.body.data.id) });
    expect(pub.status).toBe(200);
    expect(pub.body.data.emailed).toBe(false);
  });

  it('resend confirmation for a booking with no email is 409 NO_EMAIL', async () => {
    const { body } = await staffBook(9, { name: 'No Mail Two', phone: `${LOCAL}002` });
    const res = await staff.post(`${API}/admin/bookings/${body.data.id}/resend-confirmation`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_EMAIL');
  });

  it('a blank email on a known customer keeps their stored one, and the booking uses it', async () => {
    await staffBook(10, { name: 'Has Mail', phone: `${LOCAL}003`, email: 'has.mail@example.com' }).then((r) => expect(r.status).toBe(201));
    const res = await staffBook(11, { name: 'Has Mail', phone: `${LOCAL}003`, email: '' });
    expect(res.status).toBe(201);
    expect(res.body.data.contact.email).toBe('has.mail@example.com');
    expect(customerSendsFor(res.body.data.id).map((m) => m.kind)).toEqual(['booking_confirmed']);
  });

  it('lists and searches customers when one has no email, and staff can clear an email with null', async () => {
    const list = await staff.get(`${API}/admin/customers`).query({ search: 'No Mail', limit: 20 });
    expect(list.status).toBe(200);
    expect(list.body.data.data.map((c: { email: string | null }) => c.email)).toEqual([null, null]);

    const created = await staff.post(`${API}/admin/customers`).send({ name: 'Clear Me', phone: `${LOCAL}004`, email: 'clear.me@example.com' });
    expect(created.status).toBe(201);
    const cleared = await staff.patch(`${API}/admin/customers/${created.body.data.id}`).send({ email: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.email).toBeNull();
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: created.body.data.id } })).email).toBeNull();
  });

  it('a signed-in customer can check out with cash and no email', async () => {
    const customer = await signInCustomer(app, `${LOCAL}005`);
    const res = await checkout(customer, 12, '005', { paymentMethod: 'cash', customerEmail: '' });
    expect(res.status).toBe(201);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: res.body.data.bookingId } })).toMatchObject({ contactEmail: null, payAtVenue: true });
    expect(customerSendsFor(res.body.data.bookingId)).toEqual([]);
  });

  it('a guest card checkout with no email is 400 EMAIL_REQUIRED and holds nothing', async () => {
    const res = await checkout(request.agent(app.getHttpServer()), 13, '006', { paymentMethod: 'card' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMAIL_REQUIRED');
    expect(await prisma.slot.findUniqueOrThrow({ where: { id: await slotId(13) } })).toMatchObject({ status: 'available' });
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });
});
