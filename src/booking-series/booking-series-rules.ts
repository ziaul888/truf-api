import { AppError } from '../common/app-error.js';
import type { AvailableDays, SlotStatus, Weekday } from '../generated/prisma/client.js';
import { isOpenDay } from '../slots/slot-rules.js';
import { slotHour } from '../slots/slot-time.js';
import { addDays, datesBetween, hasEnded, weekdayOf, type IsoDate, type VenueNow } from '../slots/venue-time.js';

/** Why a series could not book a date. Recorded once, never retried. */
export const SKIP_REASONS = ['booked', 'blocked', 'held', 'closed', 'ended', 'no_slot'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const seriesNotFound = () => new AppError('Repeat booking not found', 404, 'SERIES_NOT_FOUND');
export const seriesStopped = () => new AppError('This repeat booking is already stopped', 409, 'SERIES_STOPPED');
export const nothingToBook = () =>
  new AppError('None of those dates has a free slot at that time. Pick other days or another time', 409, 'NOTHING_TO_BOOK');
export const amountExceedsDue = (due: number) =>
  new AppError(due > 0 ? `Only ${due} is due` : 'Nothing is due', 400, 'AMOUNT_EXCEEDS_DUE');

/** The dates from `from` to `to` (both included) that fall on one of `weekdays`. */
export const seriesDates = (from: IsoDate, to: IsoDate, weekdays: readonly string[]): IsoDate[] =>
  datesBetween(from, to).filter((date) => weekdays.includes(weekdayOf(date)));

/** What the skip check needs to know about the slot at the series' start time on a date. */
export interface SlotAtHour {
  startHour: number;
  startMinute: number;
  durationMinutes: number;
  status: SlotStatus;
  closureId: string | null;
}

/**
 * Null when the date can be booked; otherwise why not. A day the ground doesn't open, or a slot
 * a venue closure blocked, is `closed`.
 */
export function skipReasonOf(
  ground: { availableDays: AvailableDays; customDays: Weekday[] }, date: IsoDate, slot: SlotAtHour | undefined, now: VenueNow,
): SkipReason | null {
  if (!isOpenDay(ground, date)) return 'closed';
  if (!slot) return 'no_slot';
  if (hasEnded(now, date, slotHour(slot), slot.durationMinutes)) return 'ended';
  if (slot.status === 'available') return null;
  if (slot.status === 'blocked') return slot.closureId ? 'closed' : 'blocked';
  return slot.status;
}

export interface Owing {
  id: string;
  due: number;
}

/** Splits `amount` over the bookings in the order given (date order): each is filled up to its due before the next. */
export function allocate(amount: number, owing: Owing[]): { id: string; amount: number }[] {
  const parts: { id: string; amount: number }[] = [];
  let left = amount;
  for (const { id, due } of owing) {
    if (left <= 0) break;
    const part = Math.min(left, due);
    if (part > 0) parts.push({ id, amount: part });
    left -= part;
  }
  return parts;
}

/** "2026-11" → the first and last date of that month. */
export function monthRange(month: string): { from: IsoDate; to: IsoDate } {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${year + 1}-01-01` : `${year}-${String(m + 1).padStart(2, '0')}-01`;
  return { from: `${month}-01`, to: addDays(next, -1) };
}

/** "2026-11-24" → "2026-11" (dates are venue-local already). */
export const monthOf = (date: IsoDate) => date.slice(0, 7);
