import type { Prisma, Slot } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { startMinutesOf, type SlotStart } from '../slots/slot-time.js';
import { toDbDate, type IsoDate } from '../slots/venue-time.js';
import { bookingSlotLimit } from './booking-limits.js';
import { slotNotAvailable } from './booking-rules.js';
import { releaseStaleBookingSlots, tooManySlots } from './booking-slots.js';
import type { CheckoutInput } from './bookings.schemas.js';

/** The start times a checkout asks for: `slots`, or the single `startHour` / `startMinute`. Earliest first; at most MAX_SLOTS_PER_BOOKING. */
export function requestedStarts(input: Pick<CheckoutInput, 'slots' | 'startHour' | 'startMinute'>): SlotStart[] {
  const starts = input.slots ?? [{ startHour: input.startHour!, startMinute: input.startMinute }];
  const max = bookingSlotLimit();
  if (starts.length > max) throw tooManySlots(max);
  return [...starts].sort((a, b) => startMinutesOf(a) - startMinutesOf(b));
}

/** The stored slots at those start times, earliest first, in one query. Any missing: 409 SLOT_NOT_AVAILABLE. */
export async function resolveSlots(
  db: Pick<PrismaService, 'slot'>, groundId: string, date: IsoDate, starts: SlotStart[],
): Promise<Slot[]> {
  const found = await db.slot.findMany({
    where: { groundId, date: toDbDate(date), OR: starts.map(({ startHour, startMinute }) => ({ startHour, startMinute })) },
  });
  if (found.length !== starts.length) throw slotNotAvailable();
  return found.sort((a, b) => startMinutesOf(a) - startMinutesOf(b));
}

/**
 * Takes every slot with ONE conditional update (available → `data`). If any was taken meanwhile the
 * count is short and this throws 409, so the surrounding transaction rolls back and nothing stays claimed.
 * First frees stale BookingSlot live indexes left by cancelled bookings (see `releaseStaleBookingSlots`).
 */
export async function claimSlots(tx: Prisma.TransactionClient, slots: { id: string }[], data: Prisma.SlotUpdateManyMutationInput) {
  await releaseStaleBookingSlots(tx, slots.map((s) => s.id));
  const { count } = await tx.slot.updateMany({ where: { id: { in: slots.map((s) => s.id) }, status: 'available' }, data });
  if (count !== slots.length) throw slotNotAvailable();
}
