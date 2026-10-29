import type { AvailableDays, Weekday } from '../generated/prisma/client.js';

/** A peak period in whole hours: [fromHour, toHour). */
export interface PeakRange {
  fromHour: number;
  toHour: number;
}

/** The fields that decide when a ground's slots start and what they cost. */
export interface GroundSchedule {
  openingHour: number;
  closingHour: number;
  slotDurationMinutes: number;
  hourlyPrice: number;
  peakPrice: number | null;
  peakRanges: PeakRange[];
}

/**
 * Start hours of a day's slots: from openingHour, in steps of the slot length, as long as the
 * slot ends by closingHour. E.g. 6–23 with 2-hour slots → 6, 8, …, 20 (22–24 would overrun).
 */
export function slotStartHours({ openingHour, closingHour, slotDurationMinutes }: GroundSchedule): number[] {
  const step = slotDurationMinutes / 60;
  const starts: number[] = [];
  for (let hour = openingHour; hour + step <= closingHour; hour += step) starts.push(hour);
  return starts;
}

/** Price of the slot starting at `startHour`: each hour at the peak price if it falls in a peak range. */
export function slotPrice(ground: GroundSchedule, startHour: number): number {
  const hours = ground.slotDurationMinutes / 60;
  let total = 0;
  for (let hour = startHour; hour < startHour + hours; hour++) {
    total += isPeakHour(ground, hour) ? ground.peakPrice! : ground.hourlyPrice;
  }
  return total;
}

/** Whether `hour` (the hour starting then) is charged at the peak price. */
export const isPeakHour = (ground: GroundSchedule, hour: number) =>
  ground.peakPrice !== null && ground.peakRanges.some((r) => hour >= r.fromHour && hour < r.toHour);

/** The fields that decide which days a ground opens. */
export interface GroundDays {
  isActive: boolean;
  availableDays: AvailableDays;
  customDays: Weekday[];
}

/** Whether the ground takes bookings on that weekday. Weekends are Sat–Sun, as the dashboard shows. */
export function isOpenOn({ isActive, availableDays, customDays }: GroundDays, day: Weekday): boolean {
  if (!isActive) return false;
  const weekend = day === 'sat' || day === 'sun';
  switch (availableDays) {
    case 'everyday': return true;
    case 'weekdays': return !weekend;
    case 'weekends': return weekend;
    case 'custom': return customDays.includes(day);
  }
}
