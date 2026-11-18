import type { Prisma, TenantGround } from '../generated/prisma/client.js';
import { peakRangesOf } from '../grounds/ground.dto.js';
import { planDay, upcomingWhere, type SlotSpan } from '../slots/slot-rules.js';
import { fromDbDate, venueNow, type VenueNow } from '../slots/venue-time.js';

export function planOwnerSlots(
  ground: TenantGround,
  dates: string[],
  slots: (SlotSpan & { date: Date })[],
  now: VenueNow,
) {
  const byDate = new Map<string, SlotSpan[]>();
  for (const slot of slots) {
    const date = fromDbDate(slot.date);
    const group = byDate.get(date) ?? [];
    group.push(slot);
    byDate.set(date, group);
  }
  const schedule = { ...ground, peakRanges: peakRangesOf(ground) };
  const create: Prisma.TenantSlotCreateManyInput[] = [];
  let skipped = 0;
  for (const date of dates) {
    const plan = planDay(schedule, date, byDate.get(date) ?? [], now);
    create.push(
      ...plan.create.map((slot) => ({ ...slot, tenantId: ground.tenantId })),
    );
    skipped += plan.skipped;
  }
  return { create, skipped };
}

export async function resyncOwnerSlots(
  tx: Prisma.TransactionClient,
  ground: TenantGround,
  timezone: string,
) {
  const now = venueNow(new Date(), timezone);
  const upcoming: Prisma.TenantSlotWhereInput = {
    tenantId: ground.tenantId,
    groundId: ground.id,
    ...upcomingWhere(now),
  };
  const current = await tx.tenantSlot.findMany({ where: upcoming });
  const dates = [...new Set(current.map((slot) => fromDbDate(slot.date)))];
  const kept = current.filter((slot) => slot.status !== 'available');
  const { count: removed } = await tx.tenantSlot.deleteMany({
    where: { ...upcoming, status: 'available' },
  });
  const plan = planOwnerSlots(ground, dates, kept, now);
  const generated = plan.create.length
    ? (
        await tx.tenantSlot.createMany({
          data: plan.create,
          skipDuplicates: true,
        })
      ).count
    : 0;
  return { removed, generated, kept: kept.length };
}
