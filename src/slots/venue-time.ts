import { env } from '../config/env.js';
import type { Weekday } from '../generated/prisma/client.js';

// Slots live in venue-local time: a calendar date plus whole hours, never UTC timestamps.
// Dates travel as "YYYY-MM-DD" strings and are stored as Postgres DATE (UTC midnight in JS).

export type IsoDate = string;

/** The venue's current date and minutes since local midnight. */
export interface VenueNow {
  date: IsoDate;
  minutes: number;
}

const DAY_MS = 86_400_000;
const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function venueNow(now = new Date(), timeZone = env.VENUE_TIMEZONE): VenueNow {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const part = Object.fromEntries(format.formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${part.year}-${part.month}-${part.day}`, minutes: Number(part.hour) * 60 + Number(part.minute) };
}

export const toDbDate = (date: IsoDate) => new Date(`${date}T00:00:00.000Z`);
export const fromDbDate = (date: Date): IsoDate => date.toISOString().slice(0, 10);
export const addDays = (date: IsoDate, days: number) => fromDbDate(new Date(toDbDate(date).getTime() + days * DAY_MS));
export const daysBetween = (from: IsoDate, to: IsoDate) => Math.round((toDbDate(to).getTime() - toDbDate(from).getTime()) / DAY_MS);
export const weekdayOf = (date: IsoDate): Weekday => WEEKDAYS[toDbDate(date).getUTCDay()]!;

/** Every date from `from` to `to`, both included. */
export function datesBetween(from: IsoDate, to: IsoDate): IsoDate[] {
  const dates: IsoDate[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

/** Minutes until a slot starts; zero or less once it has started. */
export const minutesUntil = (now: VenueNow, date: IsoDate, startHour: number) =>
  daysBetween(now.date, date) * 1440 + startHour * 60 - now.minutes;

export const hasStarted = (now: VenueNow, date: IsoDate, startHour: number) => minutesUntil(now, date, startHour) <= 0;

/** The instant venue-local midnight starts on `date` (for comparing with timestamps like createdAt). */
export function venueDayStart(date: IsoDate, timeZone = env.VENUE_TIMEZONE): Date {
  const guess = toDbDate(date).getTime();
  const local = venueNow(new Date(guess), timeZone);
  const offsetMinutes = daysBetween(date, local.date) * 1440 + local.minutes;
  return new Date(guess - offsetMinutes * 60_000);
}
