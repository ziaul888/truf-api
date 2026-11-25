import type { Prisma, SlotStatus } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { SLOT_INCLUDE, toSlotDto } from './slot.dto.js';
import { slotHour } from './slot-time.js';
import { assertRange, dateWhere, isOpenDay } from './slot-rules.js';
import type { ListSlotsQuery } from './slots.schemas.js';
import {
  datesBetween,
  fromDbDate,
  hasStarted,
  toDbDate,
  venueNow,
  type IsoDate,
  type VenueNow,
} from './venue-time.js';

const MAX_LIST_DAYS = 366;

export const SLOT_ORDER: Prisma.SlotOrderByWithRelationInput[] = [
  { date: 'asc' },
  { startHour: 'asc' },
  { startMinute: 'asc' },
  { ground: { name: 'asc' } },
  { id: 'asc' },
];

type SlotStats = Record<SlotStatus | 'past' | 'total', number>;

function startedBy(now: VenueNow): Prisma.SlotWhereInput {
  const date = toDbDate(now.date);
  const hour = Math.floor(now.minutes / 60);
  return {
    OR: [
      { date: { lt: date } },
      {
        date,
        OR: [
          { startHour: { lt: hour } },
          { startHour: hour, startMinute: { lte: now.minutes % 60 } },
        ],
      },
    ],
  };
}

async function openDatesWhere(
  db: PrismaService,
  groundId: string,
  from: IsoDate,
  to: IsoDate,
): Promise<Prisma.SlotWhereInput> {
  const ground = await db.ground.findUnique({ where: { id: groundId } });
  const open = ground
    ? datesBetween(from, to).filter((date) => isOpenDay(ground, date))
    : [];
  return { date: { in: open.map(toDbDate) } };
}

/** Stats cover the selected grounds and dates. Schedule is independent of the stored status. */
export async function listAdminSlots(
  db: PrismaService,
  {
    page,
    limit,
    groundId,
    from,
    to,
    status,
    reason,
    schedule,
    openDaysOnly,
  }: ListSlotsQuery,
) {
  if (from && to) assertRange(from, to, MAX_LIST_DAYS);
  const base: Prisma.SlotWhereInput = { groundId, ...dateWhere(from, to) };
  const now = venueNow();
  const started = startedBy(now);
  const where: Prisma.SlotWhereInput = {
    ...base,
    ...(status && { status }),
    ...(reason && { blockReason: reason }),
    ...(schedule === 'started' && { AND: started }),
    ...(schedule === 'upcoming' && { NOT: started }),
    ...(openDaysOnly &&
      groundId &&
      from &&
      to &&
      (await openDatesWhere(db, groundId, from, to))),
  };
  const [rows, total, counts, past] = await db.$transaction(
    [
      db.slot.findMany({
        where,
        include: SLOT_INCLUDE,
        orderBy: SLOT_ORDER,
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.slot.count({ where }),
      db.slot.groupBy({
        by: ['status'],
        where: base,
        orderBy: { status: 'asc' },
        _count: { _all: true },
      }),
      db.slot.count({ where: { ...base, status: 'available', AND: started } }),
    ],
    { isolationLevel: 'RepeatableRead' },
  );
  const stats: SlotStats = {
    total: 0,
    available: 0,
    held: 0,
    booked: 0,
    blocked: 0,
    past,
  };
  for (const { status, _count } of counts) {
    stats[status] = _count._all;
    stats.total += _count._all;
  }
  stats.available -= past;
  const data = rows.map((row) => ({
    ...toSlotDto(row),
    hasStarted: hasStarted(now, fromDbDate(row.date), slotHour(row)),
  }));
  return { data, total, page, limit, stats };
}
