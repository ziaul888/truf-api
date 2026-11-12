import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { assertDayOpen, slotEnded, slotNotFound } from '../slots/slot-rules.js';
import { startMinutesOf } from '../slots/slot-time.js';
import { fromDbDate, hasEnded, venueNow } from '../slots/venue-time.js';
import { bookingSlotLimit } from './booking-limits.js';
import { slotNotAvailable } from './booking-rules.js';
import { assertSameGroundDate, tooManySlots } from './booking-slots.js';
import type { CreateStaffBookingInput } from './bookings.schemas.js';

const WITH_GROUND_DAYS = { ground: { select: { availableDays: true, customDays: true } } } satisfies Prisma.SlotInclude;
export type StaffSlot = Prisma.SlotGetPayload<{ include: typeof WITH_GROUND_DAYS }>;

/** The slot ids a staff booking asks for: `slotIds`, or the single `slotId`. */
export const staffSlotIds = (input: Pick<CreateStaffBookingInput, 'slotId' | 'slotIds'>): string[] => input.slotIds ?? [input.slotId!];

/**
 * Loads the slots of a staff booking, earliest first, and checks they can be booked together: at most
 * MAX_SLOTS_PER_BOOKING (400 TOO_MANY_SLOTS), all found (404), one ground and date (400
 * SLOTS_MUST_SHARE_GROUND_DATE), none ended (the slot must not have ended yet), all free (409), and the
 * day open. Open until a slot ends, so a team walking in just after the start can still play.
 */
export async function loadStaffSlots(db: Pick<PrismaService, 'slot'>, ids: string[]): Promise<StaffSlot[]> {
  const max = bookingSlotLimit();
  if (ids.length > max) throw tooManySlots(max);
  const slots = await db.slot.findMany({ where: { id: { in: ids } }, include: WITH_GROUND_DAYS });
  if (slots.length !== ids.length) throw slotNotFound();
  assertSameGroundDate(slots);
  const now = venueNow();
  for (const slot of slots) {
    if (hasEnded(now, fromDbDate(slot.date), startMinutesOf(slot) / 60, slot.durationMinutes)) throw slotEnded();
    if (slot.status !== 'available') throw slotNotAvailable();
  }
  assertDayOpen(slots[0]!.ground, fromDbDate(slots[0]!.date));
  return slots.sort((a, b) => startMinutesOf(a) - startMinutesOf(b));
}
