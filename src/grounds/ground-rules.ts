import { AppError } from '../common/app-error.js';
import type { AvailableDays, Ground, Prisma, Weekday } from '../generated/prisma/client.js';
import { peakRangesOf } from './ground.dto.js';
import type { PeakRange } from './ground-schedule.js';
import type { UpdateGroundInput } from './grounds.schemas.js';

/** A ground customers may see: active and not hidden from the portal. */
export const VISIBLE_GROUND: Prisma.GroundWhereInput = { isActive: true, showOnPortal: true };

// Rules that span several fields. They run in the service on the merged (stored + incoming)
// values, because an update may send only one side of a rule.

export function assertHours(openingHour: number, closingHour: number) {
  if (openingHour < closingHour) return;
  throw new AppError(`Closing hour (${closingHour}) must be after opening hour (${openingHour})`, 400, 'INVALID_HOURS');
}

/** `custom` needs at least one day; any other choice stores no custom days. */
export function resolveDays(availableDays: AvailableDays, customDays: Weekday[]) {
  if (availableDays !== 'custom') return { availableDays, customDays: [] };
  if (customDays.length === 0) {
    throw new AppError('Pick at least one day for custom availability', 400, 'INVALID_DAYS');
  }
  return { availableDays, customDays };
}

interface PeakInput {
  openingHour: number;
  closingHour: number;
  peakPrice: number | null;
  peakRanges: PeakRange[];
}

/** Peak price and ranges come as a pair; ranges sit inside opening hours and don't overlap. */
export function assertPeakPricing({ openingHour, closingHour, peakPrice, peakRanges }: PeakInput) {
  const fail = (message: string) => {
    throw new AppError(message, 400, 'INVALID_PEAK_PRICING');
  };
  if ((peakPrice === null) !== (peakRanges.length === 0)) {
    fail('Set a peak price and at least one peak range together, or neither');
  }
  const sorted = [...peakRanges].sort((a, b) => a.fromHour - b.fromHour);
  sorted.forEach((range, i) => {
    if (range.fromHour < openingHour || range.toHour > closingHour) {
      fail(`Peak range ${range.fromHour}–${range.toHour} must be within opening hours ${openingHour}–${closingHour}`);
    }
    const previous = sorted[i - 1];
    if (previous && range.fromHour < previous.toHour) {
      fail(`Peak ranges ${previous.fromHour}–${previous.toHour} and ${range.fromHour}–${range.toHour} overlap`);
    }
  });
}

/** Single-value fields that change which slots a ground has, or what they cost. */
const SCHEDULE_VALUES = [
  'openingHour', 'closingHour', 'slotDurationMinutes', 'hourlyPrice', 'peakPrice', 'availableDays', 'isActive',
] as const satisfies (keyof UpdateGroundInput)[];

const rangeKey = ({ fromHour, toHour }: PeakRange) => `${fromHour}-${toHour}`;
const sameItems = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * Whether an update really changes the schedule, so future free slots must be replaced. Lists compare by
 * value, because Postgres jsonb reorders keys and a form save sends every field even when nothing changed.
 */
export function scheduleChanged(ground: Ground, input: UpdateGroundInput): boolean {
  if (input.peakRanges && !sameItems(peakRangesOf(ground).map(rangeKey), input.peakRanges.map(rangeKey))) return true;
  if (input.customDays && !sameItems(ground.customDays, input.customDays)) return true;
  return SCHEDULE_VALUES.some((field) => input[field] !== undefined && input[field] !== ground[field]);
}
