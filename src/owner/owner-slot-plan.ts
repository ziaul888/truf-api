import type { Ground, Prisma } from '../generated/prisma/client.js';
import { peakRangesOf } from '../grounds/ground.dto.js';
import {
  activeClosuresWhere,
  closureBlock,
  closureOn,
  planDay,
  upcomingWhere,
  type SlotSpan,
} from '../slots/slot-rules.js';
import type { SlotSettings } from '../slots/slots.schemas.js';
import {
  addDays,
  datesBetween,
  fromDbDate,
  toDbDate,
  venueNow,
  type VenueNow,
} from '../slots/venue-time.js';

export async function planOwnerSlots(
  tx: Prisma.TransactionClient,
  ground: Ground,
  dates: string[],
  slots: (SlotSpan & { date: Date })[],
  now: VenueNow,
) {
  if (!dates.length) return { create: [], skipped: 0 };
  const closures = await tx.closure.findMany({
    where: activeClosuresWhere(ground.id, dates[0]!, dates.at(-1)!),
  });
  const byDate = new Map<string, SlotSpan[]>();
  for (const slot of slots) {
    const date = fromDbDate(slot.date);
    const group = byDate.get(date) ?? [];
    group.push(slot);
    byDate.set(date, group);
  }
  const schedule = { ...ground, peakRanges: peakRangesOf(ground) };
  const create: Prisma.SlotCreateManyInput[] = [];
  let skipped = 0;
  for (const date of dates) {
    const plan = planDay(schedule, date, byDate.get(date) ?? [], now);
    const closure = closureOn(closures, date);
    create.push(
      ...(closure
        ? plan.create.map((slot) => ({ ...slot, ...closureBlock(closure) }))
        : plan.create),
    );
    skipped += plan.skipped;
  }
  return { create, skipped };
}

export async function fillOwnerWindow(
  tx: Prisma.TransactionClient,
  ground: Ground,
  { autoGenerate, advanceBookingDays }: SlotSettings,
) {
  if (!ground.isActive || !autoGenerate) return;
  const now = venueNow();
  const lastDate = addDays(now.date, advanceBookingDays);
  const existing = await tx.slot.findMany({
    where: {
      groundId: ground.id,
      date: { gte: toDbDate(now.date), lte: toDbDate(lastDate) },
    },
    select: {
      date: true,
      startHour: true,
      startMinute: true,
      durationMinutes: true,
    },
  });
  const { create } = await planOwnerSlots(
    tx,
    ground,
    datesBetween(now.date, lastDate),
    existing,
    now,
  );
  if (create.length)
    await tx.slot.createMany({ data: create, skipDuplicates: true });
}

export async function resyncOwnerSlots(
  tx: Prisma.TransactionClient,
  ground: Ground,
) {
  const now = venueNow();
  const upcoming: Prisma.SlotWhereInput = {
    groundId: ground.id,
    ...upcomingWhere(now),
  };
  const current = await tx.slot.findMany({
    where: upcoming,
    include: { _count: { select: { bookings: true, bookingSlots: true } } },
  });
  const dates = [...new Set(current.map((slot) => fromDbDate(slot.date)))];
  const kept = current.filter(
    (slot) =>
      slot.status !== 'available' ||
      slot._count.bookings ||
      slot._count.bookingSlots,
  );
  const { count: removed } = await tx.slot.deleteMany({
    where: {
      ...upcoming,
      status: 'available',
      bookings: { none: {} },
      bookingSlots: { none: {} },
    },
  });
  const plan = await planOwnerSlots(tx, ground, dates, kept, now);
  const generated = plan.create.length
    ? (
        await tx.slot.createMany({
          data: plan.create,
          skipDuplicates: true,
        })
      ).count
    : 0;
  return { removed, generated, kept: kept.length };
}
