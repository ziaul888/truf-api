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
  GenerateSlotsInput,
  ListSlotsQuery,
} from '../slots/slots.schemas.js';
import { endMinutesOf, slotTimes, startMinutesOf } from '../slots/slot-time.js';
import {
  datesBetween,
  fromDbDate,
  toDbDate,
  venueNow,
  weekdayOf,
} from '../slots/venue-time.js';
import { requireOwner } from './owner-access.js';
import { ownerGround } from './owner-grounds.service.js';
import type { OwnerContext } from './owner-session.js';
import { planOwnerSlots } from './owner-slot-plan.js';
import { ownerTransaction } from './owner-transaction.js';
import { requireVenue } from './owner-venue.js';

@Injectable()
export class OwnerSlotsService {
  constructor(private readonly db: PrismaService) {}

  async today(owner: OwnerContext): Promise<DashboardToday> {
    requireVenue(owner);
    const tenantId = owner.session.tid;
    const now = venueNow(new Date(), owner.user.tenant.timezone);
    const grounds = await this.db.tenantGround.findMany({
      where: { tenantId, isActive: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      include: {
        slots: {
          where: { tenantId, date: toDbDate(now.date) },
          orderBy: [{ startHour: 'asc' }, { startMinute: 'asc' }],
        },
      },
    });
    return {
      date: now.date,
      nowHour: Math.floor(now.minutes / 60),
      grounds: grounds.map((ground) => groundToday(ground, now)),
    };
  }

  async list(owner: OwnerContext, query: ListSlotsQuery) {
    requireVenue(owner);
    const { page, limit, groundId, from, to, status, reason, openDaysOnly } =
      query;
    const tenantId = owner.session.tid;
    const base: Prisma.TenantSlotWhereInput = { tenantId, groundId };
    if (from && to) {
      assertRange(from, to, 366);
      base.date = { gte: toDbDate(from), lte: toDbDate(to) };
    }
    const where: Prisma.TenantSlotWhereInput = { ...base, status };
    if (reason) where.status = { in: [] };
    if (openDaysOnly && groundId && from && to) {
      const ground = await ownerGround(this.db, tenantId, groundId);
      where.date = {
        in: datesBetween(from, to)
          .filter((date) => isOpenDay(ground, date))
          .map(toDbDate),
      };
    }
    const [rows, total, counts] = await this.db.$transaction([
      this.db.tenantSlot.findMany({
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
      this.db.tenantSlot.count({ where }),
      this.db.tenantSlot.groupBy({
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

  generate(session: OwnerContext['session'], input: GenerateSlotsInput) {
    assertRange(input.fromDate, input.toDate, MAX_GENERATE_DAYS);
    return ownerTransaction(this.db, async (tx) => {
      const owner = await requireOwner(tx, session);
      requireVenue(owner);
      return generateForOwner(tx, owner, input);
    });
  }
}

async function generateForOwner(
  tx: Prisma.TransactionClient,
  owner: OwnerContext,
  input: GenerateSlotsInput,
) {
  const tenantId = owner.session.tid;
  const { fromDate, toDate, groundId, dryRun } = input;
  const now = venueNow(new Date(), owner.user.tenant.timezone);
  if (fromDate < now.date) {
    throw new AppError(
      'Start date must not be in the past',
      400,
      'INVALID_DATE_RANGE',
    );
  }
  const dates = datesBetween(fromDate, toDate);
  const grounds = await tx.tenantGround.findMany({
    where: {
      tenantId,
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
    const slots = await tx.tenantSlot.findMany({
      where: {
        tenantId,
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
    const plan = planOwnerSlots(ground, dates, slots, now);
    const saved =
      dryRun || !plan.create.length
        ? plan.create.length
        : (
            await tx.tenantSlot.createMany({
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

type SlotRow = Prisma.TenantSlotGetPayload<{
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

type TodayGroundRow = Prisma.TenantGroundGetPayload<{
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
