import type { AvailableDays, Weekday } from '../generated/prisma/client.js';
import type { SlotStart } from '../slots/slot-time.js';

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
 * Starts of a day's slots: from openingHour, in steps of the slot length, as long as the slot ends
 * by closingHour. E.g. 6–23 with 2-hour slots → 6:00, 8:00, …, 20:00 (22–24 would overrun);
 * 15–24 with 90-minute slots → 15:00, 16:30, 18:00, 19:30, 21:00, 22:30.
 */
export function slotStarts({ openingHour, closingHour, slotDurationMinutes }: GroundSchedule): SlotStart[] {
  const starts: SlotStart[] = [];
  for (let m = openingHour * 60; m + slotDurationMinutes <= closingHour * 60; m += slotDurationMinutes) {
    starts.push({ startHour: Math.floor(m / 60), startMinute: m % 60 });
  }
  return starts;
}

/** The half hours a slot covers, as the hour each falls in (17:30–19:00 → 17, 18, 18). */
const halfHoursOf = (ground: GroundSchedule, startHour: number, startMinute: number) =>
  Array.from({ length: ground.slotDurationMinutes / 30 }, (_, i) => Math.floor((startHour * 60 + startMinute + i * 30) / 60));

/**
 * Price of the slot starting at startHour:startMinute, summed per half hour: half the hourly price,
 * or half the peak price if that half hour's hour is in a peak range. 60 and 120 come out exactly
 * as hour by hour; an odd price over 90 minutes is rounded to the nearest unit.
 */
export function slotPrice(ground: GroundSchedule, startHour: number, startMinute = 0): number {
  const halves = halfHoursOf(ground, startHour, startMinute);
  const sum = halves.reduce((total, hour) => total + (isPeakHour(ground, hour) ? ground.peakPrice! : ground.hourlyPrice), 0);
  return Math.round(sum / 2);
}

/** Whether any half hour of the slot is charged at the peak price. */
export const isPeakSlot = (ground: GroundSchedule, startHour: number, startMinute = 0) =>
  halfHoursOf(ground, startHour, startMinute).some((hour) => isPeakHour(ground, hour));

/** Whether `hour` (the hour starting then) is charged at the peak price. */
export const isPeakHour = (ground: GroundSchedule, hour: number) =>
  ground.peakPrice !== null && ground.peakRanges.some((r) => hour >= r.fromHour && hour < r.toHour);

/** The fields that decide which days a ground opens. */
export interface GroundDays {
  isActive: boolean;
  availableDays: AvailableDays;
  customDays: Weekday[];
}

/** Whether the ground takes bookings on that weekday. Weekends are Fri–Sat, weekdays are Sun–Thu. */
export function isOpenOn({ isActive, availableDays, customDays }: GroundDays, day: Weekday): boolean {
  if (!isActive) return false;
  const weekend = day === 'fri' || day === 'sat';
  switch (availableDays) {
    case 'everyday': return true;
    case 'weekdays': return !weekend;
    case 'weekends': return weekend;
    case 'custom': return customDays.includes(day);
  }
}
