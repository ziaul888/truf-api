import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { hashPassword } from './../src/auth/password.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { addDays, toDbDate, venueNow, weekdayOf } from './../src/slots/venue-time.js';

const SLOTS = '/api/v1/admin/slots';
const SETTINGS = '/api/v1/admin/settings/slots';
const LOGIN = '/api/v1/admin/auth/login';
const DOMAIN = '@slots.test';
const PREFIX = 'E2E Slots';
const password = 'e2e-password-123';
const admin = { email: `admin${DOMAIN}`, password };
const manager = { email: `manager${DOMAIN}`, password };

// Days ahead of the venue's today, so no slot has started and none is inside the cutoff.
const today = venueNow().date;
const d1 = addDays(today, 2);
const d2 = addDays(today, 3);
const d3 = addDays(today, 4);
/** The next Monday at least 2 days out; Mon–Fri of that week has no weekend day. */
const monday = (() => {
  let d = d1;
  while (weekdayOf(d) !== 'mon') d = addDays(d, 1);
  return d;
})();

describe('Slots (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let groundId: string;
  let weekendId: string;
  let hiddenId: string;
  let resyncId: string;

  const ours = { ground: { name: { startsWith: PREFIX } } };
  const cleanup = async () => {
    await prisma.slotEvent.deleteMany({ where: ours });
    await prisma.slot.deleteMany({ where: ours });
    await prisma.closure.deleteMany({ where: { createdBy: { email: { endsWith: DOMAIN } } } });
    await prisma.ground.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await prisma.slotSettings.deleteMany();
  };

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
    // Created directly, so no slots exist until a test generates them.
    const base = { hourlyPrice: 1000, openingHour: 8, closingHour: 12 };
    const create = async (data: object) => (await prisma.ground.create({ data: { ...base, ...data } as never })).id;
    groundId = await create({ name: `${PREFIX} Main`, peakPrice: 1500, peakRanges: [{ fromHour: 11, toHour: 12 }] });
    weekendId = await create({ name: `${PREFIX} Weekend`, availableDays: 'weekends' });
    hiddenId = await create({ name: `${PREFIX} Hidden`, showOnPortal: false });
    resyncId = await create({ name: `${PREFIX} Resync` });
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterEach(() => app.close());

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function signIn(creds: { email: string; password: string }) {
    const agent = request.agent(app.getHttpServer());
    await agent.post(LOGIN).send(creds).expect(200);
    return agent;
  }

  const slotAt = (id: string, date: string, startHour: number) =>
    prisma.slot.findUniqueOrThrow({ where: { groundId_date_startHour: { groundId: id, date: toDbDate(date), startHour } } });

  it('requires sign-in', async () => {
    await request(app.getHttpServer()).get(SLOTS).expect(401);
  });

  describe('generate', () => {
    const body = { groundId: '', fromDate: d1, toDate: d3 };

    it('previews with dryRun, then creates, then skips what exists', async () => {
      const agent = await signIn(admin);
      const preview = await agent.post(`${SLOTS}/generate`).send({ ...body, groundId, dryRun: true }).expect(200);
      expect(preview.body.data).toEqual({ generated: 12, skipped: 0, days: 3, slotsPerDay: 4 });
      expect(await prisma.slot.count({ where: { groundId } })).toBe(0);

      const created = await agent.post(`${SLOTS}/generate`).send({ ...body, groundId }).expect(200);
      expect(created.body.data).toMatchObject({ generated: 12, skipped: 0 });
      expect(await slotAt(groundId, d1, 11)).toMatchObject({ price: 1500, durationMinutes: 60, status: 'available' });

      const again = await agent.post(`${SLOTS}/generate`).send({ ...body, groundId }).expect(200);
      expect(again.body.data).toMatchObject({ generated: 0, skipped: 12 });
    });

    it('is admin only', async () => {
      const agent = await signIn(manager);
      const res = await agent.post(`${SLOTS}/generate`).send({ ...body, groundId }).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it.each([
      ['overwriting', () => ({ ...body, groundId, skipExisting: false }), 'VALIDATION_FAILED'],
      ['a past start', () => ({ ...body, groundId, fromDate: addDays(today, -1) }), 'INVALID_DATE_RANGE'],
      ['over 90 days', () => ({ ...body, groundId, toDate: addDays(d1, 90) }), 'INVALID_DATE_RANGE'],
      ['a closed range', () => ({ groundId: weekendId, fromDate: monday, toDate: addDays(monday, 4) }), 'GROUND_CLOSED'],
    ])('rejects %s', async (_label, send, code) => {
      const agent = await signIn(admin);
      const res = await agent.post(`${SLOTS}/generate`).send(send()).expect(400);
      expect(res.body.code).toBe(code);
    });
  });

  describe('list, block and unblock', () => {
    it('lists a day with stats and ground names', async () => {
      const agent = await signIn(manager);
      const res = await agent.get(SLOTS).query({ groundId, date: d1 }).expect(200);
      expect(res.body.data).toMatchObject({ total: 4, page: 1, limit: 20, stats: { total: 4, available: 4, booked: 0, blocked: 0 } });
      expect(res.body.data.data[0]).toMatchObject({
        groundName: `${PREFIX} Main`, date: d1, startHour: 8, endHour: 9, price: 1000, booking: null, block: null,
      });
    });

    it('lets a manager block a slot, with a note and an audit record', async () => {
      const agent = await signIn(manager);
      const { id } = await slotAt(groundId, d1, 9);
      const res = await agent.post(`${SLOTS}/${id}/block`).send({ reason: 'maintenance', note: 'Net repair' }).expect(200);
      expect(res.body.data).toMatchObject({
        cancelledBooking: false,
        slot: { status: 'blocked', block: { reason: 'maintenance', note: 'Net repair', blockedBy: { name: 'Manager' } } },
      });
      expect(await prisma.slotEvent.count({ where: { slotId: id, action: 'block' } })).toBe(1);

      const again = await agent.post(`${SLOTS}/${id}/block`).send({ reason: 'other' }).expect(409);
      expect(again.body.code).toBe('SLOT_ALREADY_BLOCKED');

      const blocked = await agent.get(SLOTS).query({ groundId, date: d1, status: 'blocked' }).expect(200);
      expect(blocked.body.data).toMatchObject({ total: 1, stats: { total: 4, blocked: 1, available: 3 } });
    });

    it('shows customers availability without saying why', async () => {
      const res = await request(app.getHttpServer()).get(`/api/v1/grounds/${groundId}/slots`).query({ date: d1 }).expect(200);
      expect(res.body.data.map((s: { startHour: number; available: boolean }) => [s.startHour, s.available]))
        .toEqual([[8, true], [9, false], [10, true], [11, true]]);
      expect(res.body.data[3]).toEqual({
        id: expect.any(String), date: d1, startHour: 11, endHour: 12, price: 1500, isPeak: true, available: true,
      });
    });

    it('unblocks once', async () => {
      const agent = await signIn(manager);
      const { id } = await slotAt(groundId, d1, 9);
      const res = await agent.post(`${SLOTS}/${id}/unblock`).expect(200);
      expect(res.body.data).toMatchObject({ status: 'available', block: null });
      expect((await agent.post(`${SLOTS}/${id}/unblock`).expect(409)).body.code).toBe('SLOT_NOT_BLOCKED');
    });

    it('404s and validates ids', async () => {
      const agent = await signIn(admin);
      expect((await agent.get(`${SLOTS}/00000000-0000-4000-8000-000000000000`).expect(404)).body.code).toBe('SLOT_NOT_FOUND');
      expect((await agent.get(`${SLOTS}/nope`).expect(400)).body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('bulk block, calendar and bulk unblock', () => {
    it('blocks a full day and shows it on the calendar', async () => {
      const agent = await signIn(admin);
      const res = await agent.post(`${SLOTS}/block`)
        .send({ type: 'fullDay', groundId, date: d2, reason: 'event', note: 'Tournament' }).expect(200);
      expect(res.body.data).toEqual({ blocked: 4, skippedBooked: 0, cancelledBookings: 0 });

      const cal = await agent.get(`${SLOTS}/calendar`).query({ from: d1, to: d3, groundId }).expect(200);
      expect(cal.body.data.slots).toHaveLength(4);
      expect(cal.body.data.slots[0]).toMatchObject({ date: d2, status: 'blocked', note: 'event: Tournament', groundName: `${PREFIX} Main` });
      expect(cal.body.data.totals).toEqual([d1, d2, d3].map((date) => ({ date, groundId, totalSlots: 4 })));
    });

    it('unblocks a whole day', async () => {
      const agent = await signIn(manager);
      const res = await agent.post(`${SLOTS}/unblock`).send({ groundId, date: d2 }).expect(200);
      expect(res.body.data).toEqual({ unblocked: 4 });
    });

    it('blocks a weekly repeat, creating slots that did not exist yet', async () => {
      const agent = await signIn(admin);
      const start = addDays(d3, 1);
      const res = await agent.post(`${SLOTS}/block`).send({
        type: 'recurringWeekly', groundId, date: start, untilDate: addDays(start, 14),
        weekdays: [weekdayOf(start)], startHour: 10, reason: 'reserved',
      }).expect(200);
      expect(res.body.data.blocked).toBe(3);
      expect(await slotAt(groundId, addDays(start, 7), 10)).toMatchObject({ status: 'blocked', blockReason: 'reserved' });
    });

    it('refuses to block a day the ground is closed', async () => {
      const agent = await signIn(admin);
      const res = await agent.post(`${SLOTS}/block`).send({ type: 'fullDay', groundId: weekendId, date: monday, reason: 'other' }).expect(400);
      expect(res.body.code).toBe('GROUND_CLOSED');
    });
  });

  describe('settings and ground changes', () => {
    it('returns defaults, saves as admin only, and validates', async () => {
      const adminAgent = await signIn(admin);
      expect((await adminAgent.get(SETTINGS).expect(200)).body.data).toMatchObject({ advanceBookingDays: 30, autoGenerate: true });
      await (await signIn(manager)).put(SETTINGS).send({ autoGenerate: false }).expect(403);
      expect((await adminAgent.put(SETTINGS).send({ advanceBookingDays: 0 }).expect(400)).body.code).toBe('VALIDATION_FAILED');

      const res = await adminAgent.put(SETTINGS).send({ autoGenerate: false }).expect(200);
      expect(res.body.data).toEqual({
        advanceBookingDays: 30, autoGenerate: false, cancellationCutoffHours: 2, notifyCustomerOnBlock: true, notifyAdminOnBooking: false,
        holdMinutes: 15, serviceFee: 5000, portalCashEnabled: true,
        updatedAt: expect.any(String), updatedBy: { id: expect.any(String), name: 'Admin' },
      });
    });

    it('replaces free future slots when the slot length changes, keeping blocked ones', async () => {
      const agent = await signIn(admin);
      await agent.post(`${SLOTS}/generate`).send({ groundId: resyncId, fromDate: d1, toDate: d1 }).expect(200);
      const { id } = await slotAt(resyncId, d1, 9);
      await agent.post(`${SLOTS}/${id}/block`).send({ reason: 'weather' }).expect(200);

      const res = await agent.patch(`/api/v1/admin/grounds/${resyncId}`).send({ slotDurationMinutes: 120 }).expect(200);
      // 8, 10, 11 removed; 9 kept; the new 8–10 overlaps it, so only 10–12 is created.
      expect(res.body.data.slotSync).toEqual({ removed: 3, generated: 1, kept: 1 });
      const left = await prisma.slot.findMany({ where: { groundId: resyncId }, orderBy: { startHour: 'asc' } });
      expect(left.map((s) => [s.startHour, s.durationMinutes, s.status])).toEqual([[9, 60, 'blocked'], [10, 120, 'available']]);
    });
  });

  describe('history and bulk by id', () => {
    it('returns a slot\'s block history, newest first, with who did it', async () => {
      const agent = await signIn(manager);
      const { id } = await slotAt(groundId, d1, 9);
      const res = await agent.get(`${SLOTS}/${id}/history`).expect(200);
      expect(res.body.data.map((e: { action: string }) => e.action)).toEqual(['unblock', 'block']);
      expect(res.body.data[1]).toMatchObject({ reason: 'maintenance', note: 'Net repair', user: { name: 'Manager' } });
    });

    it('lists the venue timeline with filters', async () => {
      const agent = await signIn(admin);
      const res = await agent.get('/api/v1/admin/slot-events').query({ groundId, from: d1, to: d1, action: 'block' }).expect(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.data[0]).toMatchObject({ groundName: `${PREFIX} Main`, date: d1, startHour: 9, action: 'block' });
    });

    it('blocks and unblocks many slots by id, reporting failures per id', async () => {
      const agent = await signIn(manager);
      const a = await slotAt(groundId, d3, 8);
      const b = await slotAt(groundId, d3, 9);
      const first = await agent.post(`${SLOTS}/bulk`).send({ ids: [a.id], action: 'block', reason: 'other' }).expect(200);
      expect(first.body.data).toEqual({ done: 1, failed: [] });

      const second = await agent.post(`${SLOTS}/bulk`).send({ ids: [a.id, b.id], action: 'block', reason: 'other' }).expect(200);
      expect(second.body.data).toEqual({ done: 1, failed: [{ id: a.id, code: 'SLOT_ALREADY_BLOCKED', error: expect.any(String) }] });

      const unblock = await agent.post(`${SLOTS}/bulk`).send({ ids: [a.id, b.id], action: 'unblock' }).expect(200);
      expect(unblock.body.data).toEqual({ done: 2, failed: [] });
    });

    it('requires a reason to block', async () => {
      const agent = await signIn(manager);
      const { id } = await slotAt(groundId, d3, 8);
      const res = await agent.post(`${SLOTS}/bulk`).send({ ids: [id], action: 'block' }).expect(400);
      expect(res.body.details).toEqual([expect.objectContaining({ field: 'reason' })]);
    });
  });

  describe('closures', () => {
    const CLOSURES = '/api/v1/admin/closures';
    const c1 = addDays(today, 20);
    const c2 = addDays(today, 21);
    let closureId: string;

    it('closes days, including slots generated afterwards, and hides them from customers', async () => {
      const agent = await signIn(admin);
      await agent.post(`${SLOTS}/generate`).send({ groundId, fromDate: c1, toDate: c1 }).expect(200);

      const res = await agent.post(CLOSURES).send({
        fromDate: c1, toDate: c2, groundIds: [groundId], reason: 'event', note: 'Staff note', publicLabel: 'Closed for Eid',
      }).expect(201);
      expect(res.body.data).toMatchObject({ blocked: 4, skippedBooked: 0, closure: { fromDate: c1, toDate: c2, liftedAt: null } });
      closureId = res.body.data.closure.id;

      await agent.post(`${SLOTS}/generate`).send({ groundId, fromDate: c2, toDate: c2 }).expect(200);
      expect(await slotAt(groundId, c2, 8)).toMatchObject({ status: 'blocked', closureId, blockReason: 'event' });

      const publicSlots = await request(app.getHttpServer()).get(`/api/v1/grounds/${groundId}/slots`).query({ from: c1, to: c2 }).expect(200);
      expect(publicSlots.body.data).toEqual([]);
      const publicClosures = await request(app.getHttpServer()).get('/api/v1/closures').query({ from: c1, to: c2 }).expect(200);
      expect(publicClosures.body.data).toContainEqual({ fromDate: c1, toDate: c2, groundIds: [groundId], label: 'Closed for Eid' });
    });

    it('is admin only to close, and lists closures for managers', async () => {
      const agent = await signIn(manager);
      await agent.post(CLOSURES).send({ fromDate: c1, toDate: c1, reason: 'event' }).expect(403);
      const res = await agent.get(CLOSURES).expect(200);
      expect(res.body.data.data).toContainEqual(expect.objectContaining({ id: closureId, note: 'Staff note', createdBy: expect.objectContaining({ name: 'Admin' }) }));
    });

    it('lifting frees only the closure\'s own blocks, once', async () => {
      const agent = await signIn(admin);
      const own = await slotAt(groundId, c1, 10);
      await prisma.slot.update({ where: { id: own.id }, data: { closureId: null, blockReason: 'weather' } });

      const res = await agent.delete(`${CLOSURES}/${closureId}`).expect(200);
      expect(res.body.data).toEqual({ unblocked: 7 });
      expect(await slotAt(groundId, c1, 10)).toMatchObject({ status: 'blocked', blockReason: 'weather' });
      expect((await agent.delete(`${CLOSURES}/${closureId}`).expect(409)).body.code).toBe('CLOSURE_ALREADY_LIFTED');
    });

    it('validates the range', async () => {
      const agent = await signIn(admin);
      const res = await agent.post(CLOSURES).send({ fromDate: c1, toDate: addDays(c1, 31), reason: 'event' }).expect(400);
      expect(res.body.code).toBe('INVALID_DATE_RANGE');
    });
  });

  describe('public', () => {
    const get = (id: string, query: object) => request(app.getHttpServer()).get(`/api/v1/grounds/${id}/slots`).query(query);

    it('hides hidden grounds and validates the dates', async () => {
      expect((await get(hiddenId, { date: d1 }).expect(404)).body.code).toBe('GROUND_NOT_FOUND');
      expect((await get(groundId, {}).expect(400)).body.code).toBe('VALIDATION_FAILED');
      expect((await get(groundId, { from: d1, to: addDays(d1, 14) }).expect(400)).body.code).toBe('INVALID_DATE_RANGE');
    });
  });
});
