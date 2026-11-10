import type { BookingSeriesStatus, BookingStatus, Prisma } from '../generated/prisma/client.js';
import { dueOf, paidOf } from '../bookings/booking-rules.js';
import { fromDbDate, type IsoDate } from '../slots/venue-time.js';
import { monthOf, type SkipReason } from './booking-series-rules.js';

/** Joins the series response needs. */
export const SERIES_INCLUDE = {
  ground: { select: { id: true, name: true, slotDurationMinutes: true } },
  customer: { select: { id: true, name: true, phone: true } },
  bookings: {
    where: { deletedAt: null },
    orderBy: { slot: { date: 'asc' } },
    select: {
      id: true, bookingNumber: true, status: true, total: true,
      slot: { select: { date: true } },
      payments: { where: { deletedAt: null }, select: { amount: true, status: true } },
    },
  },
  skips: { orderBy: { date: 'asc' } },
} satisfies Prisma.BookingSeriesInclude;

export type SeriesRow = Prisma.BookingSeriesGetPayload<{ include: typeof SERIES_INCLUDE }>;

export interface SeriesBookingDto {
  id: string;
  bookingNumber: string;
  date: IsoDate;
  status: BookingStatus;
  total: number;
  paid: number;
  due: number;
}

export interface SeriesSums {
  bookings: number;
  total: number;
  paid: number;
  due: number;
}

/** One calendar month (venue time) of the series: live bookings only; cancelled ones are counted apart. */
export interface SeriesMonthDto extends SeriesSums {
  month: string;
  cancelled: number;
}

export interface SeriesDto {
  id: string;
  status: BookingSeriesStatus;
  ground: { id: string; name: string };
  customer: { id: string; name: string; phone: string };
  startHour: number;
  endHour: number;
  weekdays: string[];
  fromDate: IsoDate;
  /** Null = ongoing. */
  untilDate: IsoDate | null;
  /** The last date considered (booked or skipped). */
  bookedThrough: IsoDate | null;
  notes: string | null;
  createdAt: Date;
  stoppedAt: Date | null;
  /** Live bookings (cancelled left out). */
  totals: SeriesSums;
  months: SeriesMonthDto[];
  /** Every booking, cancelled included, in date order. */
  bookings: SeriesBookingDto[];
  skipped: { date: IsoDate; reason: SkipReason }[];
}

const emptySums = (): SeriesSums => ({ bookings: 0, total: 0, paid: 0, due: 0 });

function add(sums: SeriesSums, b: SeriesBookingDto) {
  sums.bookings++;
  sums.total += b.total;
  sums.paid += b.paid;
  sums.due += b.due;
}

/** Totals and per-month sums, months in order. Cancelled bookings only add to their month's `cancelled`. */
export function summarise(bookings: SeriesBookingDto[]): { totals: SeriesSums; months: SeriesMonthDto[] } {
  const totals = emptySums();
  const months = new Map<string, SeriesMonthDto>();
  for (const b of bookings) {
    const month = monthOf(b.date);
    const sums = months.get(month) ?? { month, ...emptySums(), cancelled: 0 };
    months.set(month, sums);
    if (b.status === 'cancelled') {
      sums.cancelled++;
      continue;
    }
    add(sums, b);
    add(totals, b);
  }
  return { totals, months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)) };
}

const toSeriesBooking = (b: SeriesRow['bookings'][number]): SeriesBookingDto => ({
  id: b.id, bookingNumber: b.bookingNumber, date: fromDbDate(b.slot.date), status: b.status,
  total: b.total, paid: paidOf(b.payments), due: dueOf(b, b.payments),
});

export function toSeriesDto(s: SeriesRow): SeriesDto {
  const bookings = s.bookings.map(toSeriesBooking);
  return {
    id: s.id, status: s.status,
    ground: { id: s.ground.id, name: s.ground.name },
    customer: { id: s.customer.id, name: s.customer.name, phone: s.customer.phone ?? s.contactPhone },
    startHour: s.startHour, endHour: s.startHour + s.ground.slotDurationMinutes / 60, weekdays: s.weekdays,
    fromDate: fromDbDate(s.fromDate), untilDate: s.untilDate ? fromDbDate(s.untilDate) : null,
    bookedThrough: s.bookedThrough ? fromDbDate(s.bookedThrough) : null,
    notes: s.notes, createdAt: s.createdAt, stoppedAt: s.stoppedAt,
    ...summarise(bookings),
    bookings,
    skipped: s.skips.map((k) => ({ date: fromDbDate(k.date), reason: k.reason as SkipReason })),
  };
}
