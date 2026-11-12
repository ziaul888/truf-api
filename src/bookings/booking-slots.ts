import { AppError } from '../common/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import { upcomingWhere } from '../slots/slot-rules.js';
import { endMinutesOf, slotTimes, startMinutesOf, type SlotClock, type SlotTimes } from '../slots/slot-time.js';
import { fromDbDate, hasEnded, hasStarted, type IsoDate, type VenueNow } from '../slots/venue-time.js';

// A booking holds 1 to 4 slots of one ground and one date (`BookingSlot` rows). `Booking.slot` is the
// earliest ("primary") one. Cancelling is all or nothing, so a booking's slots are all live or all cancelled.

/** A stored slot with its date and clock. */
export interface SlotRef extends SlotClock {
  id: string;
  date: Date;
}

/** A `BookingSlot` row with its slot. */
export interface BookingSlotRef {
  cancelledAt: Date | null;
  price: number;
  slot: SlotRef;
}

/** What a booking row needs to carry for these helpers (the `slot` and `bookingSlots` joins). */
export interface BookingSlotsSource {
  slot: SlotRef;
  amount?: number;
  cancelledAt?: Date | null;
  bookingSlots: BookingSlotRef[];
}

/** The booked span: one date, from the earliest live slot's start to the last live slot's end, in minutes since midnight. */
export interface BookingWindow {
  date: IsoDate;
  startMinutes: number;
  endMinutes: number;
}

export const tooManySlots = (max: number) => new AppError(`A booking can hold at most ${max} slots`, 400, 'TOO_MANY_SLOTS');
export const slotsMustShareGroundDate = () =>
  new AppError('All the slots of a booking must be on the same ground and the same date', 400, 'SLOTS_MUST_SHARE_GROUND_DATE');

const byStart = (a: BookingSlotRef, b: BookingSlotRef) => a.slot.date.getTime() - b.slot.date.getTime() || startMinutesOf(a.slot) - startMinutesOf(b.slot);

/**
 * Every slot of the booking, earliest first. A booking made by an older release (during a deploy) has
 * no `BookingSlot` rows yet: its single `slot` stands in, at the booking's amount.
 */
export function slotRowsOf(b: BookingSlotsSource): BookingSlotRef[] {
  if (b.bookingSlots.length === 0) return [{ cancelledAt: b.cancelledAt ?? null, price: b.amount ?? 0, slot: b.slot }];
  return [...b.bookingSlots].sort(byStart);
}

/** The slots still in the booking (not cancelled), earliest first. */
export const liveSlots = (b: BookingSlotsSource): BookingSlotRef[] => slotRowsOf(b).filter((s) => s.cancelledAt === null);

/** The live slots; a cancelled booking has none, so all its slots. For anything shown or measured on a booking whatever its state. */
export const currentSlots = (b: BookingSlotsSource): BookingSlotRef[] => {
  const live = liveSlots(b);
  return live.length > 0 ? live : slotRowsOf(b);
};

/** The earliest live slot; a cancelled booking has none live, so its earliest slot. */
export const primaryOf = (b: BookingSlotsSource): BookingSlotRef => {
  const rows = slotRowsOf(b);
  return rows.find((s) => s.cancelledAt === null) ?? rows[0]!;
};

/** The span of some slots of one date: the earliest start to the latest end. */
export const spanOf = (slots: SlotRef[]): BookingWindow => ({
  date: fromDbDate(slots[0]!.date),
  startMinutes: Math.min(...slots.map(startMinutesOf)),
  endMinutes: Math.max(...slots.map(endMinutesOf)),
});

/** The span of the live slots (a cancelled booking: of all its slots). */
export const windowOf = (b: BookingSlotsSource): BookingWindow => spanOf(currentSlots(b).map((s) => s.slot));

/** The window as the start and end times every response carries. */
export const windowTimes = (w: BookingWindow): SlotTimes =>
  slotTimes({ startHour: Math.floor(w.startMinutes / 60), startMinute: w.startMinutes % 60, durationMinutes: w.endMinutes - w.startMinutes });

export const windowHasStarted = (now: VenueNow, w: BookingWindow) => hasStarted(now, w.date, w.startMinutes / 60);

export const windowHasEnded = (now: VenueNow, w: BookingWindow) => hasEnded(now, w.date, w.startMinutes / 60, w.endMinutes - w.startMinutes);

/** Hours played: the live slots' durations (a cancelled booking: all its slots'). */
export const hoursOf = (b: BookingSlotsSource): number => currentSlots(b).reduce((sum, s) => sum + s.slot.durationMinutes, 0) / 60;

/**
 * A booking with a slot that has not started yet: its primary slot, or any live BookingSlot (the primary is
 * the earliest, so a multi-slot booking stays upcoming until its LAST slot starts). The first branch keeps
 * bookings written without BookingSlot rows (older release) working.
 */
export const hasUpcomingSlot = (now: VenueNow): Prisma.BookingWhereInput => ({
  OR: [{ slot: upcomingWhere(now) }, { bookingSlots: { some: { cancelledAt: null, slot: upcomingWhere(now) } } }],
});

/**
 * Frees BookingSlot live indexes still set on CANCELLED bookings for these slots. An older release (running
 * during a deploy) cancels bookings without knowing BookingSlot, which would wedge the slot with a unique clash.
 * Run in the same transaction, before creating BookingSlot rows.
 */
export const releaseStaleBookingSlots = (tx: Prisma.TransactionClient, slotIds: string[]) =>
  tx.bookingSlot.updateMany({
    where: { slotId: { in: slotIds }, liveSlotId: { not: null }, booking: { status: 'cancelled' } },
    data: { liveSlotId: null, cancelledAt: new Date() },
  });

export const sumPrice = (slots: { price: number }[]) => slots.reduce((sum, s) => sum + s.price, 0);

/** Throws 400 SLOTS_MUST_SHARE_GROUND_DATE unless every slot is on one ground and one date. */
export function assertSameGroundDate(slots: { groundId: string; date: Date }[]) {
  const first = slots[0];
  if (first && slots.some((s) => s.groundId !== first.groundId || s.date.getTime() !== first.date.getTime())) throw slotsMustShareGroundDate();
}
