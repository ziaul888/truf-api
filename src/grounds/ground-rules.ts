import { AppError } from '../common/app-error.js';
import type { AvailableDays, Prisma, Weekday } from '../generated/prisma/client.js';
import type { PeakRange } from './ground-schedule.js';

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
