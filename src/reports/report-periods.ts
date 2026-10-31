import { AppError } from '../common/app-error.js';
import { addDays, daysBetween, toDbDate, venueDayStart, venueNow, type IsoDate } from '../slots/venue-time.js';
import type { GroupBy, ReportRange } from './reports.schemas.js';

/** One chart point's dates. `period` is its first date, clipped to the range like `end`. */
export interface Period {
  period: IsoDate;
  end: IsoDate;
  label: string;
}

const MAX_DAYS = 366;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const lengthOf = (r: ReportRange) => daysBetween(r.from, r.to) + 1;

export function assertReportRange(r: ReportRange) {
  if (lengthOf(r) > MAX_DAYS) throw new AppError(`Pick a range of at most ${MAX_DAYS} days`, 400, 'RANGE_TOO_LONG');
}

/** The same number of days immediately before `from`. */
export function previousRange(r: ReportRange): ReportRange {
  return { from: addDays(r.from, -lengthOf(r)), to: addDays(r.from, -1) };
}

/** % change, one decimal; null when there's nothing to compare with. */
export const trendOf = (now: number, before: number) => (before === 0 ? null : Math.round(((now - before) / before) * 1000) / 10);

/** part ÷ whole as a %, one decimal; null when whole is 0. */
export const percent = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 10);

export const autoGroupBy = (r: ReportRange): GroupBy => (lengthOf(r) <= 31 ? 'day' : lengthOf(r) <= 92 ? 'week' : 'month');

/** Weeks start on Saturday, the first day of the working week in Bangladesh. */
function periodStart(date: IsoDate, groupBy: GroupBy): IsoDate {
  if (groupBy === 'day') return date;
  if (groupBy === 'week') return addDays(date, -((toDbDate(date).getUTCDay() + 1) % 7));
  return `${date.slice(0, 7)}-01`;
}

function periodEnd(start: IsoDate, groupBy: GroupBy): IsoDate {
  if (groupBy === 'day') return start;
  if (groupBy === 'week') return addDays(start, 6);
  const [year, month] = start.split('-').map(Number) as [number, number];
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  return addDays(next, -1);
}

const dayMonth = (date: IsoDate) => `${Number(date.slice(8))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;

/** "31 Oct", "24 – 30 Oct", "28 Oct – 3 Nov", "Oct 2026". */
function labelOf(start: IsoDate, end: IsoDate, groupBy: GroupBy): string {
  if (groupBy === 'day') return dayMonth(start);
  if (groupBy === 'month') return `${MONTHS[Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)}`;
  if (start === end) return dayMonth(start);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return `${sameMonth ? Number(start.slice(8)) : dayMonth(start)} – ${dayMonth(end)}`;
}

/** Every period in the range, in order, including empty ones. */
export function periodsOf(r: ReportRange, groupBy: GroupBy): Period[] {
  const periods: Period[] = [];
  for (let start = periodStart(r.from, groupBy); start <= r.to; start = addDays(periodEnd(start, groupBy), 1)) {
    const period = start < r.from ? r.from : start;
    const end = periodEnd(start, groupBy) > r.to ? r.to : periodEnd(start, groupBy);
    periods.push({ period, end, label: labelOf(period, end, groupBy) });
  }
  return periods;
}

/** The `period` key a date falls in. */
export const periodKeyOf = (date: IsoDate, r: ReportRange, groupBy: GroupBy) => {
  const start = periodStart(date, groupBy);
  return start < r.from ? r.from : start;
};

/** The instants covering the range's venue-local days, for timestamp columns. */
export const instantsOf = (r: ReportRange) => ({ gte: venueDayStart(r.from), lt: venueDayStart(addDays(r.to, 1)) });

/** The venue-local date of an instant (a payment at 00:30 Dhaka time belongs to that day). */
export const venueDateOf = (instant: Date): IsoDate => venueNow(instant).date;
