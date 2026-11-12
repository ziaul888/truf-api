import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { hashPassword } from './../src/auth/password.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { EmailService } from './../src/email/email.service.js';
import { StripeService } from './../src/payments/stripe.service.js';
import { SlotGeneratorService } from './../src/slots/slot-generator.service.js';
import { addDays, toDbDate, venueNow, weekdayOf, type IsoDate } from './../src/slots/venue-time.js';

const API = '/api/v1';
const DOMAIN = '@ground-days.test';
const PREFIX = 'E2E Days';
const PHONE = '0177300000';
const STORED_PHONE = '+880177300000';
const password = 'e2e-password-123';
const admin = { email: `admin${DOMAIN}`, password };

const nextDay = (day: string): IsoDate => {
  let date = addDays(venueNow().date, 2);
  while (weekdayOf(date) !== day) date = addDays(date, 1);
  return date;
};
const sunday = nextDay('sun');
const friday = nextDay('fri');
const saturday = nextDay('sat');

describe('Ground days and rules (e2e)', () => {
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
      .overrideProvider(StripeService).useValue({})
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
  // Only this file's grounds: e2e files share one database and run in parallel.
  const retire = (...groundIds: string[]) => app.get(SlotGeneratorService).retireClosedDays(groundIds);

  const groundWithSlots = async (name: string, data: object, slots: [IsoDate, number][]) => {
    const ground = await prisma.ground.create({
      data: { name: `${PREFIX} ${name}`, sport: 'football', hourlyPrice: 1000, openingHour: 8, closingHour: 12, ...data },
    });
    await prisma.slot.createMany({
      data: slots.map(([date, startHour]) => ({ groundId: ground.id, date: toDbDate(date), startHour, price: 1000 })),
    });
    return ground.id;
  };
  const slotAt = (groundId: string, date: IsoDate, startHour: number) =>
    prisma.slot.findUnique({ where: { groundId_date_startHour_startMinute: { groundId, date: toDbDate(date), startHour, startMinute: 0 } } });
  const book = async (agent: Awaited<ReturnType<typeof signIn>>, groundId: string, startHour: number, phoneEnd: string) => {
    const slot = await slotAt(groundId, sunday, startHour);
    const res = await agent.post(`${API}/admin/bookings`).send({
      slotId: slot!.id, customer: { name: 'Walk In', phone: `${PHONE}${phoneEnd}`, email: 'walk@in.test' }, payment: { type: 'none' },
    }).expect(201);
    return res.body.data.id as string;
  };

  /** Bookings can't be made on a closed day, so a test books first, then closes the day. */
  const closeOnSundays = (groundId: string) => prisma.ground.update({ where: { id: groundId }, data: { availableDays: 'weekends' } });

  describe('retireClosedDays', () => {
    it('removes free slots on days now closed, and leaves open days and past days alone', async () => {
      const past = addDays(sunday, -14);
      const groundId = await groundWithSlots('Free', { availableDays: 'weekends' }, [
        [sunday, 8], [friday, 8], [saturday, 8], [past, 8],
      ]);
      await retire(groundId);
      expect(await slotAt(groundId, sunday, 8)).toBeNull();
      expect(await slotAt(groundId, friday, 8)).toMatchObject({ status: 'available' });
      expect(await slotAt(groundId, saturday, 8)).toMatchObject({ status: 'available' });
      expect(await slotAt(groundId, past, 8)).toMatchObject({ status: 'available' });
    });

    it('treats Friday and Saturday as closed for weekdays grounds', async () => {
      const groundId = await groundWithSlots('Weekdays', { availableDays: 'weekdays' }, [[friday, 8], [saturday, 8], [sunday, 8]]);
      await retire(groundId);
      expect(await slotAt(groundId, friday, 8)).toBeNull();
      expect(await slotAt(groundId, saturday, 8)).toBeNull();
      expect(await slotAt(groundId, sunday, 8)).toMatchObject({ status: 'available' });
    });

    it('leaves everyday and custom grounds alone', async () => {
      const everyday = await groundWithSlots('Everyday', {}, [[sunday, 8]]);
      const custom = await groundWithSlots('Custom', { availableDays: 'custom', customDays: ['mon'] }, [[sunday, 8]]);
      await retire(everyday, custom);
      expect(await slotAt(everyday, sunday, 8)).toMatchObject({ status: 'available' });
      expect(await slotAt(custom, sunday, 8)).toMatchObject({ status: 'available' });
    });

    it('keeps a booked closed-day slot, which can still be cancelled but is not offered again', async () => {
      const agent = await signIn();
      const groundId = await groundWithSlots('Booked', {}, [[sunday, 9]]);
      const bookingId = await book(agent, groundId, 9, '1');
      await closeOnSundays(groundId);
      await retire(groundId);
      expect(await slotAt(groundId, sunday, 9)).toMatchObject({ status: 'booked' });

      await agent.post(`${API}/admin/bookings/${bookingId}/cancel`).send({ reason: 'Customer asked', refund: false }).expect(200);
      const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
      expect(booking).toMatchObject({ status: 'cancelled', liveSlotId: null });
      const open = await request(app.getHttpServer()).get(`${API}/grounds/${groundId}/slots`).query({ date: sunday }).expect(200);
      expect(open.body.data).toEqual([]);

      // Not offered means not bookable either: the freed row refuses a direct request, from anyone.
      const slot = await slotAt(groundId, sunday, 9);
      expect(slot).toMatchObject({ status: 'available' });
      const refused = await request(app.getHttpServer()).post(`${API}/checkout`).send({
        groundId, date: sunday, startHour: 9, customerName: 'Rakib Hasan', customerEmail: 'r@x.test', customerPhone: `${PHONE}3`, paymentMethod: 'card',
      }).expect(400);
      expect(refused.body.code).toBe('GROUND_CLOSED');
      const refusedStaff = await agent.post(`${API}/admin/bookings`).send({
        slotId: slot!.id, customer: { name: 'Walk In', phone: `${PHONE}4`, email: 'walk@in.test' }, payment: { type: 'none' },
      }).expect(400);
      expect(refusedStaff.body.code).toBe('GROUND_CLOSED');
      expect(await slotAt(groundId, sunday, 9)).toMatchObject({ status: 'available' });
    });

    it('blocks a free closed-day slot that has an old cancelled booking, and logs it with no user', async () => {
      const agent = await signIn();
      const groundId = await groundWithSlots('Old booking', {}, [[sunday, 10]]);
      const bookingId = await book(agent, groundId, 10, '2');
      await agent.post(`${API}/admin/bookings/${bookingId}/cancel`).send({ reason: 'Customer asked', refund: false }).expect(200);
      expect(await slotAt(groundId, sunday, 10)).toMatchObject({ status: 'available' });

      await closeOnSundays(groundId);
      await retire(groundId);
      const slot = await slotAt(groundId, sunday, 10);
      expect(slot).toMatchObject({ status: 'blocked', blockReason: 'other', blockNote: 'Day no longer open', blockedById: null });
      const events = await prisma.slotEvent.findMany({ where: { slotId: slot!.id } });
      expect(events).toEqual([expect.objectContaining({ action: 'block', reason: 'other', note: 'Day no longer open', userId: null })]);
    });

    it('keeps an inactive ground\'s open days, which must not all count as closed', async () => {
      const groundId = await groundWithSlots('Inactive', { availableDays: 'weekends', isActive: false }, [[friday, 8], [saturday, 8], [sunday, 8]]);
      await retire(groundId);
      expect(await slotAt(groundId, friday, 8)).toMatchObject({ status: 'available' });
      expect(await slotAt(groundId, saturday, 8)).toMatchObject({ status: 'available' });
      expect(await slotAt(groundId, sunday, 8)).toBeNull();
    });

    it('does nothing to a ground on a second run', async () => {
      const groundId = await groundWithSlots('Twice', { availableDays: 'weekends' }, [[sunday, 8], [saturday, 8]]);
      await retire(groundId);
      const before = await prisma.slot.findMany({ where: { groundId } });
      await retire(groundId);
      expect(await prisma.slot.findMany({ where: { groundId } })).toEqual(before);
      expect(await prisma.slotEvent.count({ where: { groundId } })).toBe(0);
    });
  });

  describe('saving a ground', () => {
    const peak = { peakPrice: 1500, peakRanges: [{ fromHour: 10, toHour: 12 }] };

    it('does not resync on a rules-only save, and shows the rules publicly', async () => {
      const agent = await signIn();
      const groundId = await groundWithSlots('Rules', {}, [[sunday, 8]]);
      const rules = 'No metal studs.\nArrive 10 minutes early.';
      const before = await slotAt(groundId, sunday, 8);

      const saved = await agent.patch(`${API}/admin/grounds/${groundId}`).send({ rules }).expect(200);
      expect(saved.body.data.rules).toBe(rules);
      expect(saved.body.data).not.toHaveProperty('slotSync');
      expect(await slotAt(groundId, sunday, 8)).toEqual(before);

      const shown = await request(app.getHttpServer()).get(`${API}/grounds/${groundId}`).expect(200);
      expect(shown.body.data.rules).toBe(rules);
      await agent.patch(`${API}/admin/grounds/${groundId}`).send({ rules: null }).expect(200);
      expect((await request(app.getHttpServer()).get(`${API}/grounds/${groundId}`).expect(200)).body.data.rules).toBeNull();
    });

    it.each(['', '   '])('stores blank rules (%j) as null', async (rules) => {
      const agent = await signIn();
      const groundId = await groundWithSlots(`Blank rules ${rules.length}`, { rules: 'Old' }, []);
      const saved = await agent.patch(`${API}/admin/grounds/${groundId}`).send({ rules }).expect(200);
      expect(saved.body.data.rules).toBeNull();
    });

    it('rolls the ground and its slots back when the resync fails, and the retry resyncs', async () => {
      const agent = await signIn();
      const groundId = await groundWithSlots('Failed sync', {}, [[sunday, 8]]);
      const before = await slotAt(groundId, sunday, 8);
      const generator = app.get(SlotGeneratorService);
      const resync = generator.resync.bind(generator);
      vi.spyOn(generator, 'resync').mockImplementationOnce(async (tx, id) => {
        await resync(tx, id);
        throw new Error('resync failed after its writes');
      });

      await agent.patch(`${API}/admin/grounds/${groundId}`).send({ openingHour: 9 }).expect(500);
      expect(await prisma.ground.findUniqueOrThrow({ where: { id: groundId } })).toMatchObject({ openingHour: 8 });
      expect(await slotAt(groundId, sunday, 8)).toEqual(before);

      const retried = await agent.patch(`${API}/admin/grounds/${groundId}`).send({ openingHour: 9 }).expect(200);
      expect(retried.body.data).toMatchObject({ openingHour: 9, slotSync: { removed: 1 } });
      expect(await slotAt(groundId, sunday, 8)).toBeNull();
      expect(await slotAt(groundId, sunday, 9)).toMatchObject({ status: 'available' });
    });

    it('rejects rules over 2000 characters', async () => {
      const agent = await signIn();
      const groundId = await groundWithSlots('Long rules', {}, []);
      await agent.patch(`${API}/admin/grounds/${groundId}`).send({ rules: 'x'.repeat(2000) }).expect(200);
      await agent.patch(`${API}/admin/grounds/${groundId}`).send({ rules: 'x'.repeat(2001) }).expect(400);
    });

    it('does not resync when identical peak ranges come back from the form', async () => {
      const agent = await signIn();
      const groundId = await groundWithSlots('Same peak', peak, [[sunday, 8]]);
      const before = await slotAt(groundId, sunday, 8);
      const saved = await agent.patch(`${API}/admin/grounds/${groundId}`).send(peak).expect(200);
      expect(saved.body.data).not.toHaveProperty('slotSync');
      expect(await slotAt(groundId, sunday, 8)).toEqual(before);
    });

    it('still resyncs when the peak ranges really change', async () => {
      const agent = await signIn();
      const groundId = await groundWithSlots('New peak', peak, [[sunday, 8]]);
      const saved = await agent.patch(`${API}/admin/grounds/${groundId}`)
        .send({ peakRanges: [{ fromHour: 9, toHour: 12 }] }).expect(200);
      expect(saved.body.data.slotSync).toBeDefined();
    });
  });
});
