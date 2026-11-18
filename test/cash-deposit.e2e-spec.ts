import { randomBytes } from 'node:crypto';
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
const LOGIN = `${API}/admin/auth/login`;
const SLOT_SETTINGS = `${API}/admin/settings/slots`;
const DOMAIN = '@cash-deposit.test';
const PREFIX = 'E2E Cash Deposit';
/** Every customer phone in this file starts with this, for cleanup. */
const PHONE = '+88017990110';
const password = 'e2e-password-123';
const admin = { email: `admin${DOMAIN}`, password };
const manager = { email: `manager${DOMAIN}`, password };
const BKASH = '+8801700000111';
const NAGAD = '+8801700000112';

const today = venueNow().date;
const d1 = addDays(today, 2);
const d2 = addDays(today, 3);

/** A fresh TrxID per call, so a second run never clashes with the first. */
const trx = () => `T${randomBytes(5).toString('hex').toUpperCase()}`;

const stripe = {
  createCheckoutSession: vi.fn(
    async ({ bookingId }: { bookingId: string }) => ({
      id: `cs_${bookingId}`,
      url: `https://stripe.test/${bookingId}`,
    }),
  ),
  openSessionUrl: vi.fn(async () => null),
  expireSession: vi.fn(async () => undefined),
  refund: vi.fn(async (intentId: string) => `re_${intentId}`),
  cardLast4: vi.fn(async () => '4242'),
  parseWebhook: vi.fn(),
};
const email = { send: vi.fn(async () => true) };

/**
 * Booking money for cash bookings: a portal cash checkout also pays a deposit by bKash / Nagad.
 * The settings row is shared with the other e2e files, so every test sets what it needs right before its
 * checkout (and the file puts the deposit back off at the end). Not run by the implementer: run it alone.
 */
describe('cash booking deposit (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let groundId: string;

  const cleanup = async () => {
    const grounds = await prisma.ground.findMany({
      where: { name: { startsWith: PREFIX } },
      select: { id: true },
    });
    const ids = grounds.map((g) => g.id);
    await prisma.bookingEvent.deleteMany({
      where: { booking: { groundId: { in: ids } } },
    });
    await prisma.payment.deleteMany({
      where: { booking: { groundId: { in: ids } } },
    });
    await prisma.bookingSlot.deleteMany({
      where: { booking: { groundId: { in: ids } } },
    });
    await prisma.booking.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.customer.deleteMany({
      where: { phone: { startsWith: PHONE } },
    });
    await prisma.slot.deleteMany({ where: { groundId: { in: ids } } });
    await prisma.ground.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  };

  const setSettings = (data: {
    cashDepositEnabled: boolean;
    cashDepositPercent?: number;
    bkashNumber?: string | null;
    nagadNumber?: string | null;
    serviceFee?: number;
  }) => {
    const settings = {
      portalCashEnabled: true,
      portalBkashEnabled: true,
      portalNagadEnabled: true,
      serviceFee: 5000,
      bkashNumber: BKASH,
      nagadNumber: NAGAD,
      cashDepositPercent: 30,
      ...data,
    };
    return prisma.slotSettings.upsert({
      where: { id: 1 },
      create: { id: 1, ...settings },
      update: settings,
    });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await cleanup();
    const passwordHash = await hashPassword(password);
    await prisma.user.createMany({
      data: [
        { email: admin.email, name: 'Admin', role: 'admin', passwordHash },
        {
          email: manager.email,
          name: 'Manager',
          role: 'manager',
          passwordHash,
        },
      ],
    });
    groundId = (
      await prisma.ground.create({
        data: {
          name: `${PREFIX} Main`,
          sport: 'football',
          hourlyPrice: 1000,
          openingHour: 8,
          closingHour: 12,
        },
      })
    ).id;
    const slots = [d1, d2].flatMap((date) =>
      [8, 9, 10, 11].map((startHour) => ({
        groundId,
        date: toDbDate(date),
        startHour,
        price: 1000,
      })),
    );
    await prisma.slot.createMany({ data: slots });
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeService)
      .useValue(stripe)
      .overrideProvider(EmailService)
      .useValue(email)
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterEach(() => app.close());

  afterAll(async () => {
    await cleanup();
    await prisma.slotSettings.updateMany({
      data: {
        cashDepositEnabled: false,
        cashDepositPercent: 30,
        bkashNumber: null,
        nagadNumber: null,
      },
    });
    await prisma.$disconnect();
  });

  async function signIn(creds: { email: string; password: string }) {
    const agent = request.agent(app.getHttpServer());
    await agent.post(LOGIN).send(creds).expect(200);
    return agent;
  }

  const http = () => request(app.getHttpServer());
  const slotAt = (date: string, startHour: number) =>
    prisma.slot.findUniqueOrThrow({
      where: {
        groundId_date_startHour_startMinute: {
          groundId,
          date: toDbDate(date),
          startHour,
          startMinute: 0,
        },
      },
    });
  const booking = (id: string) =>
    prisma.booking.findUniqueOrThrow({
      where: { id },
      include: { payments: true },
    });
  const options = async () =>
    (await http().get(`${API}/checkout/options`).expect(200)).body.data;
  /** Cash needs a signed-in customer. */
  const cashCheckout = async (
    date: string,
    hour: number,
    extra: object,
    status: number,
  ) => {
    const customer = await signInCustomer(app, '01799011001');
    return customer
      .post(`${API}/checkout`)
      .send({
        groundId,
        date,
        hour,
        customerName: 'Nusrat Jahan',
        customerEmail: 'nusrat@cash-deposit.test',
        customerPhone: '01799011001',
        paymentMethod: 'cash',
        ...extra,
      })
      .expect(status);
  };
  const deposit = (extra: object = {}) => ({
    depositMethod: 'bkash',
    reference: trx(),
    payerNumber: '01811000111',
    ...extra,
  });

  describe('settings', () => {
    it('admins set the switch and the percent (1 to 100); managers cannot', async () => {
      await (
        await signIn(manager)
      )
        .put(SLOT_SETTINGS)
        .send({ cashDepositEnabled: true })
        .expect(403);
      const admins = await signIn(admin);
      const res = await admins
        .put(SLOT_SETTINGS)
        .send({ cashDepositEnabled: true, cashDepositPercent: 40 })
        .expect(200);
      expect(res.body.data).toMatchObject({
        cashDepositEnabled: true,
        cashDepositPercent: 40,
      });
      for (const cashDepositPercent of [0, 101, 12.5]) {
        expect(
          (
            await admins
              .put(SLOT_SETTINGS)
              .send({ cashDepositPercent })
              .expect(400)
          ).body.code,
        ).toBe('VALIDATION_FAILED');
      }
      expect(
        (await admins.get(SLOT_SETTINGS).expect(200)).body.data,
      ).toMatchObject({ cashDepositEnabled: true, cashDepositPercent: 40 });
      await admins
        .put(SLOT_SETTINGS)
        .send({ cashDepositEnabled: false, cashDepositPercent: 30 })
        .expect(200);
    });

    it('options: percent only when on and a wallet is offered; cash hidden when on with no wallet', async () => {
      await setSettings({ cashDepositEnabled: false });
      expect(await options()).toMatchObject({
        cashEnabled: true,
        cashDepositPercent: null,
      });
      await setSettings({ cashDepositEnabled: true, cashDepositPercent: 25 });
      expect(await options()).toMatchObject({
        cashEnabled: true,
        cashDepositPercent: 25,
      });
      await setSettings({
        cashDepositEnabled: true,
        bkashNumber: null,
        nagadNumber: null,
      });
      expect(await options()).toMatchObject({
        cashEnabled: false,
        cashDepositPercent: null,
        wallets: [],
      });
      await setSettings({
        cashDepositEnabled: true,
        bkashNumber: null,
        nagadNumber: null,
      });
      expect((await cashCheckout(d1, 8, {}, 400)).body.code).toBe(
        'CASH_NOT_AVAILABLE',
      );
      expect(await slotAt(d1, 8)).toMatchObject({ status: 'available' });
    });
  });

  describe('with the deposit off', () => {
    it('cash works as before and the deposit fields are refused', async () => {
      await setSettings({ cashDepositEnabled: false });
      const refused = await cashCheckout(d1, 8, deposit(), 400);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
      expect(await slotAt(d1, 8)).toMatchObject({ status: 'available' });
      const ok = await cashCheckout(d1, 8, {}, 201);
      const b = await booking(ok.body.data.bookingId);
      expect(b).toMatchObject({
        status: 'pending',
        payAtVenue: true,
        total: 6000,
      });
      expect(b.payments).toEqual([]);
      await prisma.booking.update({
        where: { id: b.id },
        data: { status: 'cancelled', liveSlotId: null },
      });
      await prisma.bookingSlot.updateMany({
        where: { bookingId: b.id },
        data: { liveSlotId: null },
      });
      await prisma.slot.updateMany({
        where: { groundId, date: toDbDate(d1), startHour: 8 },
        data: { status: 'available' },
      });
    });
  });

  describe('with the deposit on', () => {
    let bookingId: string;
    let reference: string;

    it('refuses a cash checkout without the deposit fields, claiming nothing', async () => {
      await setSettings({ cashDepositEnabled: true });
      expect((await cashCheckout(d1, 9, {}, 400)).body.code).toBe(
        'CASH_DEPOSIT_REQUIRED',
      );
      expect(
        (await cashCheckout(d1, 9, deposit({ reference: undefined }), 400)).body
          .code,
      ).toBe('CASH_DEPOSIT_REQUIRED');
      expect(
        (await cashCheckout(d1, 9, { ...deposit(), reference: 'AB-1' }, 400))
          .body.code,
      ).toBe('VALIDATION_FAILED');
      expect(await slotAt(d1, 9)).toMatchObject({ status: 'available' });
    });

    it('refuses a wallet that is not offered, and depositMethod on card', async () => {
      await setSettings({ cashDepositEnabled: true, nagadNumber: null });
      expect(
        (await cashCheckout(d1, 9, deposit({ depositMethod: 'nagad' }), 400))
          .body.code,
      ).toBe('WALLET_NOT_AVAILABLE');
      const card = await http()
        .post(`${API}/checkout`)
        .send({
          groundId,
          date: d1,
          hour: 9,
          customerName: 'Nusrat Jahan',
          customerEmail: 'nusrat@cash-deposit.test',
          customerPhone: '01799011002',
          paymentMethod: 'card',
          depositMethod: 'bkash',
        })
        .expect(400);
      expect(card.body.code).toBe('VALIDATION_FAILED');
      expect(await slotAt(d1, 9)).toMatchObject({ status: 'available' });
    });

    it('books the slot as cash with one pending bKash payment for the deposit (30% of 6000 = 1800)', async () => {
      await setSettings({ cashDepositEnabled: true });
      reference = trx();
      const res = await cashCheckout(
        d1,
        9,
        deposit({ reference: `  ${reference.toLowerCase()} ` }),
        201,
      );
      bookingId = res.body.data.bookingId;
      expect(res.body.data).toMatchObject({
        paymentMethod: 'cash',
        checkoutUrl: null,
      });
      expect(await slotAt(d1, 9)).toMatchObject({
        status: 'booked',
        heldUntil: null,
      });
      const b = await booking(bookingId);
      expect(b).toMatchObject({
        status: 'pending',
        paymentStatus: 'unpaid',
        payAtVenue: true,
        total: 6000,
      });
      expect(b.payments).toEqual([
        expect.objectContaining({
          method: 'bkash',
          status: 'pending',
          amount: 1800,
          reference,
          payerNumber: '+8801811000111',
        }),
      ]);
      expect(email.send).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringContaining('received'),
          text: expect.stringContaining('remaining 42.00'),
        }),
      );
    });

    it('the customer sees the deposit under review: nothing to pay yet, no direct cancel', async () => {
      const token = bookingToken(bookingId);
      const res = await http()
        .get(`${API}/bookings/${bookingId}`)
        .query({ token })
        .expect(200);
      expect(res.body.data).toMatchObject({
        status: 'pending',
        payAtVenue: true,
        paid: 0,
        canPay: false,
        canCancel: false,
        canRequestCancel: true,
        walletPayment: {
          method: 'bkash',
          amount: 1800,
          reference,
          status: 'pending',
        },
      });
      expect(
        (
          await http()
            .post(`${API}/bookings/${bookingId}/pay`)
            .query({ token })
            .expect(409)
        ).body.code,
      ).toBe('PAYMENT_UNDER_REVIEW');
    });

    it('the same TrxID is refused on a second cash deposit', async () => {
      await setSettings({ cashDepositEnabled: true });
      const res = await cashCheckout(d1, 10, deposit({ reference }), 409);
      expect(res.body.code).toBe('REFERENCE_ALREADY_USED');
      expect(await slotAt(d1, 10)).toMatchObject({ status: 'available' });
    });

    it('is not a card checkout, and staff cannot collect money while it is under review', async () => {
      const agent = await signIn(manager);
      expect(
        (
          await agent
            .post(`${API}/admin/bookings/${bookingId}/payments`)
            .send({ amount: 100, method: 'cash' })
            .expect(409)
        ).body.code,
      ).toBe('PAYMENT_UNDER_REVIEW');
      const queue = await agent
        .get(`${API}/admin/bookings`)
        .query({ status: 'pending', groundId })
        .expect(200);
      expect(
        queue.body.data.data.find((b: { id: string }) => b.id === bookingId),
      ).toMatchObject({
        payAtVenue: true,
        walletPayment: { method: 'bkash', status: 'pending', amount: 1800 },
      });
      const due = await agent
        .get(`${API}/admin/bookings`)
        .query({ due: 'any', groundId })
        .expect(200);
      expect(due.body.data.data.map((b: { id: string }) => b.id)).not.toContain(
        bookingId,
      );
    });

    it('staff Verify: confirmed, partial, balance of 4200 due in cash', async () => {
      const agent = await signIn(manager);
      const res = await agent
        .post(`${API}/admin/bookings/${bookingId}/confirm`)
        .send({ notifyCustomer: true })
        .expect(200);
      expect(res.body.data).toMatchObject({
        status: 'confirmed',
        paymentStatus: 'partial',
        paid: 1800,
        due: 4200,
        payAtVenue: true,
        walletPayment: { status: 'succeeded' },
      });
      expect(email.send).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringContaining('confirmed'),
          text: expect.stringContaining('remaining 42.00'),
        }),
      );
      // At the venue staff collect the rest in cash.
      const paid = await agent
        .post(`${API}/admin/bookings/${bookingId}/payments`)
        .send({ amount: 4200, method: 'cash' })
        .expect(201);
      expect(paid.body.data).toMatchObject({
        paymentStatus: 'paid',
        paid: 6000,
        due: 0,
      });
    });

    it('staff Reject: cancelled, the deposit payment fails and the slot is free', async () => {
      await setSettings({ cashDepositEnabled: true });
      const res = await cashCheckout(d2, 8, deposit(), 201);
      const id = res.body.data.bookingId;
      const rejected = await (
        await signIn(manager)
      )
        .post(`${API}/admin/bookings/${id}/cancel`)
        .send({
          reason: 'No such TrxID in our bKash app',
          refund: false,
          rejectWalletPayment: true,
        })
        .expect(200);
      expect(rejected.body.data).toMatchObject({
        status: 'cancelled',
        walletPayment: { method: 'bkash', status: 'failed' },
      });
      expect((await booking(id)).payments[0]).toMatchObject({
        status: 'failed',
      });
      expect(await slotAt(d2, 8)).toMatchObject({ status: 'available' });
    });

    it('a 100% deposit covers the total: Verify makes it paid, never above the total', async () => {
      await setSettings({ cashDepositEnabled: true, cashDepositPercent: 100 });
      const res = await cashCheckout(d2, 9, deposit(), 201);
      const id = res.body.data.bookingId;
      expect((await booking(id)).payments[0]).toMatchObject({ amount: 6000 });
      const verified = await (
        await signIn(manager)
      )
        .post(`${API}/admin/bookings/${id}/confirm`)
        .send({})
        .expect(200);
      expect(verified.body.data).toMatchObject({
        status: 'confirmed',
        paymentStatus: 'paid',
        paid: 6000,
        due: 0,
      });
    });

    it('counts once towards the 3 open unpaid bookings per phone', async () => {
      await setSettings({ cashDepositEnabled: true });
      const customer = await signInCustomer(app, '01799011003');
      const body = (hour: number) => ({
        groundId,
        date: d2,
        hour,
        customerName: 'Open Limit',
        customerEmail: 'limit@cash-deposit.test',
        customerPhone: '01799011003',
        paymentMethod: 'cash',
        ...deposit(),
      });
      for (const hour of [10, 11])
        await customer.post(`${API}/checkout`).send(body(hour)).expect(201);
      const open = await prisma.booking.count({
        where: {
          contactPhone: '+8801799011003',
          status: 'pending',
          payAtVenue: true,
        },
      });
      expect(open).toBe(2);
    });
  });
});
