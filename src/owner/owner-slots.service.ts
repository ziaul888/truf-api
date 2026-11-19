import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import type {
  DashboardToday,
  GroundToday,
} from '../dashboard/dashboard-today.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { isOpenOn, slotStarts } from '../grounds/ground-schedule.js';
import { peakRangesOf } from '../grounds/ground.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  MAX_GENERATE_DAYS,
  type GenerateResult,
} from '../slots/slot-generator.service.js';
import {
  assertRange,
  groundClosed,
  groundNotFound,
  isOpenDay,
} from '../slots/slot-rules.js';
import type {
  CalendarQuery,
  GenerateSlotsInput,
  ListSlotsQuery,
} from '../slots/slots.schemas.js';
import { slotCalendar } from '../slots/slots.service.js';
import { endMinutesOf, slotTimes, startMinutesOf } from '../slots/slot-time.js';
import {
  datesBetween,
  fromDbDate,
  toDbDate,
  venueNow,
  weekdayOf,
} from '../slots/venue-time.js';
import { ownerGround } from './owner-grounds.service.js';
import type { TenantOperator } from './owner-session.js';
import { planOwnerSlots } from './owner-slot-plan.js';
import { ownerTransaction } from './owner-transaction.js';
import { requireVenue } from './owner-venue.js';
import { TenantDashboardDatabase } from './tenant-dashboard-database.service.js';

@Injectable()
export class OwnerSlotsService {
  constructor(
    private readonly db: PrismaService,
    private readonly dashboard: TenantDashboardDatabase,
  ) {}

  calendar(owner: TenantOperator, query: CalendarQuery) {
    requireVenue(owner);
    return this.dashboard.run(owner.user.tenant, () =>
      slotCalendar(this.db, query),
    );
  }

  async today(owner: TenantOperator): Promise<DashboardToday> {
    requireVenue(owner);
    const now = venueNow(new Date(), owner.user.tenant.timezone);
    const grounds = await this.dashboard.run(owner.user.tenant, () =>
      this.db.ground.findMany({
        where: { isActive: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        include: {
          slots: {
            where: { date: toDbDate(now.date) },
            orderBy: [{ startHour: 'asc' }, { startMinute: 'asc' }],
          },
        },
      }),
    );
    return {
      date: now.date,
      nowHour: Math.floor(now.minutes / 60),
      grounds: grounds.map((ground) => groundToday(ground, now)),
    };
  }

  async list(owner: TenantOperator, query: ListSlotsQuery) {
    requireVenue(owner);
    return this.dashboard.run(owner.user.tenant, () => this.listInTurf(query));
  }

  private async listInTurf(query: ListSlotsQuery) {
    const { page, limit, groundId, from, to, status, reason, openDaysOnly } =
      query;
    const base: Prisma.SlotWhereInput = { groundId };
    if (from && to) {
      assertRange(from, to, 366);
      base.date = { gte: toDbDate(from), lte: toDbDate(to) };
    }
    const where: Prisma.SlotWhereInput = {
      ...base,
      status,
      blockReason: reason,
    };
    if (openDaysOnly && groundId && from && to) {
      const ground = await ownerGround(this.db, groundId);
      where.date = {
        in: datesBetween(from, to)
          .filter((date) => isOpenDay(ground, date))
          .map(toDbDate),
      };
    }
    const [rows, total, counts] = await this.db.$transaction([
      this.db.slot.findMany({
        where,
        include: { ground: { select: { name: true } } },
        orderBy: [
          { date: 'asc' },
          { startHour: 'asc' },
          { startMinute: 'asc' },
          { id: 'asc' },
        ],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.db.slot.count({ where }),
      this.db.slot.groupBy({
        by: ['status'],
        where: base,
        _count: { _all: true },
      }),
    ]);
    const stats = { available: 0, held: 0, booked: 0, blocked: 0, total: 0 };
    for (const { status, _count } of counts) {
      stats[status] = _count._all;
      stats.total += _count._all;
    }
    return { data: rows.map(slotDto), total, page, limit, stats };
  }

  generate(session: TenantOperator['session'], input: GenerateSlotsInput) {
    assertRange(input.fromDate, input.toDate, MAX_GENERATE_DAYS);
    return this.dashboard.runForAdmin(session, () =>
      ownerTransaction(this.db, (tx) => generateForOwner(tx, input)),
    );
  }
}

async function generateForOwner(
  tx: Prisma.TransactionClient,
  input: GenerateSlotsInput,
) {
  const { fromDate, toDate, groundId, dryRun } = input;
  const now = venueNow();
  if (fromDate < now.date) {
    throw new AppError(
      'Start date must not be in the past',
      400,
      'INVALID_DATE_RANGE',
    );
  }
  const dates = datesBetween(fromDate, toDate);
  const grounds = await tx.ground.findMany({
    where: {
      isActive: true,
      ...(groundId !== 'all' && { id: groundId }),
    },
    orderBy: { id: 'asc' },
  });
  if (groundId !== 'all') {
    const [ground] = grounds;
    if (!ground) throw groundNotFound();
    if (!dates.some((date) => isOpenOn(ground, weekdayOf(date))))
      throw groundClosed();
  }

  const result: GenerateResult = {
    generated: 0,
    skipped: 0,
    days: dates.length,
    slotsPerDay: 0,
  };
  for (const ground of grounds) {
    const slots = await tx.slot.findMany({
      where: {
        groundId: ground.id,
        date: { gte: toDbDate(fromDate), lte: toDbDate(toDate) },
      },
      select: {
        date: true,
        startHour: true,
        startMinute: true,
        durationMinutes: true,
      },
    });
    const plan = await planOwnerSlots(tx, ground, dates, slots, now);
    const saved =
      dryRun || !plan.create.length
        ? plan.create.length
        : (
            await tx.slot.createMany({
              data: plan.create,
              skipDuplicates: true,
            })
          ).count;
    result.generated += saved;
    result.skipped += plan.skipped + plan.create.length - saved;
    result.slotsPerDay += slotStarts({
      ...ground,
      peakRanges: peakRangesOf(ground),
    }).length;
  }
  return result;
}

type SlotRow = Prisma.SlotGetPayload<{
  include: { ground: { select: { name: true } } };
}>;

function slotDto(row: SlotRow) {
  const { id, groundId, durationMinutes, price, status, createdAt, updatedAt } =
    row;
  return {
    id,
    groundId,
    durationMinutes,
    price,
    status,
    createdAt,
    updatedAt,
    groundName: row.ground.name,
    date: fromDbDate(row.date),
    ...slotTimes(row),
    booking: null,
    block: null,
    heldUntil: null,
  };
}

type TodayGroundRow = Prisma.GroundGetPayload<{
  include: { slots: true };
}>;

function groundToday(
  ground: TodayGroundRow,
  now: { date: string; minutes: number },
): GroundToday {
  const { id, name, sport, format, openingHour, closingHour } = ground;
  const slots = {
    available: 0,
    held: 0,
    blocked: 0,
    booked: 0,
    total: ground.slots.length,
  };
  let freeMinutes = 0;
  for (const slot of ground.slots) {
    slots[slot.status]++;
    if (slot.status === 'available') {
      freeMinutes += Math.max(
        0,
        endMinutesOf(slot) - Math.max(startMinutesOf(slot), now.minutes),
      );
    }
  }
  return {
    groundId: id,
    groundName: name,
    sport,
    format,
    openingHour,
    closingHour,
    slots,
    closedReason: isOpenDay(ground, now.date) ? null : 'Not open today',
    bookedHours: 0,
    remainingFreeHours: Math.round(freeMinutes / 6) / 10,
    revenueToday: 0,
    current: null,
    next: null,
    timeline: ground.slots.map((slot) => ({
      ...slotTimes(slot),
      status: slot.status,
    })),
  };
}
