import { Injectable } from '@nestjs/common';
import type { BookingStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toDbDate, type IsoDate } from '../slots/venue-time.js';
import {
  bookingTotals, emptyStatusCounts, loadBookings, loadMoney, moneyTotals, type MoneyEvent, type MoneyTotals, type StatusCounts,
} from './report-data.js';
import { assertReportRange, autoGroupBy, percent, periodKeyOf, periodsOf, previousRange, trendOf, type Period } from './report-periods.js';
import type { GroupBy, ReportRange, ReportSeriesQuery } from './reports.schemas.js';

export interface ReportSummary {
  period: ReportRange;
  previous: ReportRange;
  revenue: number;
  revenueTrend: number | null;
  received: number;
  refunds: number;
  revenueByMethod: MoneyTotals['byMethod'];
  bookings: number;
  bookingsTrend: number | null;
  avgBookingValue: number;
  avgBookingValueTrend: number | null;
  completionRate: number | null;
  completionRateTrend: number | null;
  cancellationRate: number;
  statusCounts: StatusCounts;
}

/** A revenue point, plus what the CSV export needs (`end`, `byMethod`). */
export type RevenueRow = Period & Omit<MoneyTotals, 'byMethod'> & { byMethod: MoneyTotals['byMethod']; bookings: number };
export type RevenuePoint = Omit<RevenueRow, 'end' | 'byMethod'>;
export type BookingsPoint = Omit<Period, 'end'> & StatusCounts & { total: number };

export interface GroundReportRow {
  groundId: string;
  groundName: string;
  isActive: boolean;
  revenue: number;
  bookings: number;
  cancelled: number;
  hoursBooked: number;
  hoursAvailable: number;
  utilization: number | null;
}

const groupByOf = (q: ReportSeriesQuery): GroupBy => q.groupBy ?? autoGroupBy(q);

/**
 * Read-only aggregates for the Reports pages and dashboard charts. Revenue is dated by when money
 * moved (matching the dashboard and the bank); bookings by their slot date. One venue's rows are
 * small enough to aggregate in memory.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(r: ReportRange): Promise<ReportSummary> {
    assertReportRange(r);
    const previous = previousRange(r);
    const [money, moneyBefore, bookings, bookingsBefore] = await Promise.all([
      loadMoney(this.prisma, r), loadMoney(this.prisma, previous), loadBookings(this.prisma, r), loadBookings(this.prisma, previous),
    ]);
    const m = moneyTotals(money);
    const mb = moneyTotals(moneyBefore);
    const b = bookingTotals(bookings);
    const bb = bookingTotals(bookingsBefore);
    return {
      period: { from: r.from, to: r.to }, previous,
      revenue: m.revenue, revenueTrend: trendOf(m.revenue, mb.revenue),
      received: m.received, refunds: m.refunds, revenueByMethod: m.byMethod,
      bookings: b.bookings, bookingsTrend: trendOf(b.bookings, bb.bookings),
      avgBookingValue: b.avgBookingValue, avgBookingValueTrend: trendOf(b.avgBookingValue, bb.avgBookingValue),
      completionRate: b.completionRate,
      completionRateTrend: b.completionRate === null || bb.completionRate === null ? null : trendOf(b.completionRate, bb.completionRate),
      cancellationRate: b.cancellationRate,
      statusCounts: b.statusCounts,
    };
  }

  async revenue(q: ReportSeriesQuery): Promise<{ groupBy: GroupBy; points: RevenuePoint[] }> {
    const groupBy = groupByOf(q);
    const rows = await this.revenueRows(q, groupBy);
    return { groupBy, points: rows.map(({ end: _end, byMethod: _byMethod, ...point }) => point) };
  }

  /** Revenue per period, with every period present. Also used by the CSV export. */
  async revenueRows(r: ReportRange, groupBy: GroupBy): Promise<RevenueRow[]> {
    assertReportRange(r);
    const [money, bookings] = await Promise.all([loadMoney(this.prisma, r), loadBookings(this.prisma, r)]);
    const moneyBy = groupInto<MoneyEvent>(money, (e) => periodKeyOf(e.date, r, groupBy));
    const bookingsBy = groupInto(bookings, (b) => periodKeyOf(b.date, r, groupBy));
    return periodsOf(r, groupBy).map((p) => ({
      ...p, ...moneyTotals(moneyBy.get(p.period) ?? []), bookings: bookingsBy.get(p.period)?.length ?? 0,
    }));
  }

  async bookings(q: ReportSeriesQuery): Promise<{ groupBy: GroupBy; points: BookingsPoint[] }> {
    assertReportRange(q);
    const groupBy = groupByOf(q);
    const byPeriod = groupInto(await loadBookings(this.prisma, q), (b) => periodKeyOf(b.date, q, groupBy));
    const points = periodsOf(q, groupBy).map(({ period, label }) => {
      const counts = emptyStatusCounts();
      const list = byPeriod.get(period) ?? [];
      for (const b of list) counts[b.status as BookingStatus] += 1;
      return { period, label, ...counts, total: list.length };
    });
    return { groupBy, points };
  }

  /** Every active ground, plus inactive ones with activity in the range; highest revenue first. */
  async grounds(r: ReportRange): Promise<GroundReportRow[]> {
    assertReportRange(r);
    const [grounds, money, bookings, open] = await Promise.all([
      this.prisma.ground.findMany({ select: { id: true, name: true, isActive: true } }),
      loadMoney(this.prisma, r),
      loadBookings(this.prisma, r),
      this.openMinutesByGround(r.from, r.to),
    ]);
    const moneyBy = groupInto(money, (e) => e.groundId);
    const bookingsBy = groupInto(bookings, (b) => b.groundId);
    return grounds
      .map((g) => {
        const list = bookingsBy.get(g.id) ?? [];
        const kept = list.filter((b) => b.status !== 'cancelled');
        const hoursBooked = kept.reduce((sum, b) => sum + b.hours, 0);
        const hoursAvailable = (open.get(g.id) ?? 0) / 60;
        return {
          groundId: g.id, groundName: g.name, isActive: g.isActive,
          revenue: moneyTotals(moneyBy.get(g.id) ?? []).revenue,
          bookings: list.length, cancelled: list.length - kept.length,
          hoursBooked, hoursAvailable, utilization: percent(hoursBooked, hoursAvailable),
        };
      })
      .filter((row) => row.isActive || row.revenue !== 0 || row.bookings > 0)
      .sort((a, b) => b.revenue - a.revenue || a.groundName.localeCompare(b.groundName));
  }

  /** Slot minutes per ground in the range, minus blocked slots (admin blocks and closures). */
  private async openMinutesByGround(from: IsoDate, to: IsoDate): Promise<Map<string, number>> {
    const rows = await this.prisma.slot.groupBy({
      by: ['groundId'],
      where: { date: { gte: toDbDate(from), lte: toDbDate(to) }, status: { not: 'blocked' } },
      _sum: { durationMinutes: true },
    });
    return new Map(rows.map((row) => [row.groundId, row._sum.durationMinutes ?? 0]));
  }
}

function groupInto<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return map;
}
