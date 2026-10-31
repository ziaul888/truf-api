import { Injectable } from '@nestjs/common';
import { BOOKING_INCLUDE } from '../bookings/booking.dto.js';
import { dueOf, paidOf } from '../bookings/booking-rules.js';
import { CUSTOMER_SUMMARY_INCLUDE, toCustomerDto } from '../customers/customer.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { endHourOf } from '../slots/slot.dto.js';
import { fromDbDate, venueNow } from '../slots/venue-time.js';
import { csvLine, csvMoney } from './csv.js';
import { reportBookingsWhere } from './report-data.js';
import { assertReportRange, instantsOf } from './report-periods.js';
import type { ExportQuery, GroupBy, ReportRange } from './reports.schemas.js';
import { ReportsService } from './reports.service.js';

export interface CsvFile {
  filename: string;
  /** CSV lines, produced as they're read from the database. */
  lines: AsyncIterable<string>;
}

const BATCH = 500;
const hh = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
/** Venue-local "YYYY-MM-DD HH:mm". */
const localTime = (instant: Date) => {
  const { date, minutes } = venueNow(instant);
  return `${date} ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

/** CSV exports for the Export page. Validates before returning, so errors still come back as JSON. */
@Injectable()
export class ReportExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
  ) {}

  open(q: ExportQuery): CsvFile {
    const range = q.from && q.to ? { from: q.from, to: q.to } : null;
    if (range) assertReportRange(range);
    const suffix = range ? `${range.from}-to-${range.to}` : venueNow().date;
    const filename = `${q.type}-${suffix}.csv`;
    if (q.type === 'revenue') return { filename, lines: this.revenue(range!, q.groupBy as GroupBy) };
    if (q.type === 'bookings') return { filename, lines: this.bookings(range!) };
    return { filename, lines: this.customers(range) };
  }

  private async *revenue(r: ReportRange, groupBy: GroupBy): AsyncGenerator<string> {
    yield csvLine(['Period start', 'Period end', 'Received', 'Refunds', 'Net revenue', 'Card', 'Cash', 'Bank transfer', 'Bookings']);
    for (const row of await this.reports.revenueRows(r, groupBy)) {
      yield csvLine([
        row.period, row.end, csvMoney(row.received), csvMoney(row.refunds), csvMoney(row.revenue),
        csvMoney(row.byMethod.card), csvMoney(row.byMethod.cash), csvMoney(row.byMethod.bank_transfer), row.bookings,
      ]);
    }
  }

  private async *bookings(r: ReportRange): AsyncGenerator<string> {
    yield csvLine([
      'Booking #', 'Customer', 'Phone', 'Ground', 'Date', 'Start', 'End', 'Amount', 'Service fee', 'Total', 'Paid', 'Due',
      'Status', 'Payment status', 'Source', 'Created',
    ]);
    for (let cursor: string | undefined; ;) {
      const rows = await this.prisma.booking.findMany({
        where: reportBookingsWhere(r), include: BOOKING_INCLUDE, take: BATCH,
        orderBy: [{ slot: { date: 'asc' } }, { slot: { startHour: 'asc' } }, { id: 'asc' }],
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      });
      for (const b of rows) {
        yield csvLine([
          b.bookingNumber, b.contactName, b.contactPhone, b.ground.name, fromDbDate(b.slot.date), hh(b.slot.startHour), hh(endHourOf(b.slot)),
          csvMoney(b.amount), csvMoney(b.serviceFee), csvMoney(b.total), csvMoney(paidOf(b.payments)), csvMoney(dueOf(b, b.payments)),
          b.status, b.paymentStatus, b.source, localTime(b.createdAt),
        ]);
      }
      if (rows.length < BATCH) return;
      cursor = rows.at(-1)!.id;
    }
  }

  /** All customers, or those created in the range. */
  private async *customers(r: ReportRange | null): AsyncGenerator<string> {
    yield csvLine(['Name', 'Phone', 'Email', 'Customer since', 'Bookings', 'Total spent', 'Last booking', 'Due amount', 'Tag']);
    for (let cursor: string | undefined; ;) {
      const rows = await this.prisma.customer.findMany({
        where: { deletedAt: null, ...(r && { createdAt: instantsOf(r) }) }, include: CUSTOMER_SUMMARY_INCLUDE, take: BATCH,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      });
      for (const c of rows.map(toCustomerDto)) {
        yield csvLine([
          c.name, c.phone, c.email, venueNow(c.createdAt).date, c.bookings, csvMoney(c.totalSpent), c.lastBooking, csvMoney(c.dueAmount), c.tag,
        ]);
      }
      if (rows.length < BATCH) return;
      cursor = rows.at(-1)!.id;
    }
  }
}
