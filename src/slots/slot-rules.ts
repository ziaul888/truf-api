import { AppError } from '../common/app-error.js';
import type { BlockReason, Closure, Prisma, Slot, SlotEventAction } from '../generated/prisma/client.js';
import { isOpenOn, slotPrice, slotStartHours, type GroundDays, type GroundSchedule } from '../grounds/ground-schedule.js';
import { daysBetween, fromDbDate, hasStarted, toDbDate, weekdayOf, type IsoDate, type VenueNow } from './venue-time.js';

export const slotNotFound = () => new AppError('Slot not found', 404, 'SLOT_NOT_FOUND');
export const groundNotFound = () => new AppError('Ground not found', 404, 'GROUND_NOT_FOUND');
export const slotInPast = () => new AppError('This slot has already started', 400, 'SLOT_IN_PAST');
export const groundClosed = (message = 'The ground is closed on that day') => new AppError(message, 400, 'GROUND_CLOSED');

/** `from` must not be after `to`, and the range (both ends included) at most `maxDays` long. */
export function assertRange(from: IsoDate, to: IsoDate, maxDays: number) {
  if (from > to) throw new AppError('Start date must not be after end date', 400, 'INVALID_DATE_RANGE');
  if (daysBetween(from, to) + 1 > maxDays) {
    throw new AppError(`Pick a range of at most ${maxDays} days`, 400, 'INVALID_DATE_RANGE');
  }
}

/** `date` between `from` and `to` (both optional together). */
export const dateWhere = (from?: IsoDate, to?: IsoDate): Prisma.SlotWhereInput =>
  from && to ? { date: { gte: toDbDate(from), lte: toDbDate(to) } } : {};

/** Slots that have not started yet, in venue time. */
export const upcomingWhere = (now: VenueNow): Prisma.SlotWhereInput => ({
  OR: [
    { date: { gt: toDbDate(now.date) } },
    { date: toDbDate(now.date), startHour: { gt: Math.floor(now.minutes / 60) } },
  ],
});

/** What generation needs to know about a ground. */
export type GroundForSlots = GroundSchedule & GroundDays & { id: string };

/** A stored slot's place in the day, for overlap checks. */
export interface SlotSpan {
  startHour: number;
  durationMinutes: number;
}

export interface DayPlan {
  create: Prisma.SlotCreateManyInput[];
  skipped: number;
}

/**
 * The slots to create for one ground on one day: the ground's schedule, minus any slot that
 * overlaps a stored one (a kept booking, or a slot of the old length) or has already started.
 * Closed days plan nothing.
 */
export function planDay(ground: GroundForSlots, date: IsoDate, existing: SlotSpan[], now: VenueNow): DayPlan {
  if (!isOpenOn(ground, weekdayOf(date))) return { create: [], skipped: 0 };
  const hours = ground.slotDurationMinutes / 60;
  const plan: DayPlan = { create: [], skipped: 0 };
  for (const startHour of slotStartHours(ground)) {
    const overlaps = existing.some((e) => startHour < e.startHour + e.durationMinutes / 60 && e.startHour < startHour + hours);
    if (overlaps || hasStarted(now, date, startHour)) {
      plan.skipped++;
      continue;
    }
    plan.create.push({
      groundId: ground.id,
      date: toDbDate(date),
      startHour,
      durationMinutes: ground.slotDurationMinutes,
      price: slotPrice(ground, startHour),
    });
  }
  return plan;
}

/** Clears a block, including the closure that made it. */
export const UNBLOCK_DATA = {
  status: 'available' as const, blockReason: null, blockNote: null, blockedById: null, blockedAt: null, closureId: null,
};

/** One audit row per slot; keeps ground, date and hour so it outlives the slot. */
export const eventRows = (
  slots: Slot[], action: SlotEventAction, userId: string, block?: { reason: BlockReason; note?: string | null },
): Prisma.SlotEventCreateManyInput[] =>
  slots.map((s) => ({
    slotId: s.id, groundId: s.groundId, date: s.date, startHour: s.startHour, action, userId,
    reason: block?.reason ?? null, note: block?.note ?? null,
  }));

/** Closures not lifted that overlap `from`–`to`, for one ground (closures with no groundIds cover every ground). */
export const activeClosuresWhere = (groundId: string, from: IsoDate, to: IsoDate): Prisma.ClosureWhereInput => ({
  liftedAt: null,
  fromDate: { lte: toDbDate(to) },
  toDate: { gte: toDbDate(from) },
  OR: [{ groundIds: { isEmpty: true } }, { groundIds: { has: groundId } }],
});

export const closureOn = (closures: Closure[], date: IsoDate) =>
  closures.find((c) => fromDbDate(c.fromDate) <= date && date <= fromDbDate(c.toDate));

/** The block fields a closure puts on its slots. */
export const closureBlock = (c: Closure) => ({
  status: 'blocked' as const, blockReason: c.reason, blockNote: c.note, blockedById: c.createdById, blockedAt: new Date(), closureId: c.id,
});
