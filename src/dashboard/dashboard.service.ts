import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { addDays, toDbDate, venueDayStart, venueNow, type IsoDate } from '../slots/venue-time.js';

export interface DashboardStats {
  todayRevenue: number;
  todayRevenueTrend: number | null;
  todayBookings: number;
  todayBookingsTrend: number | null;
  totalCustomers: number;
  totalCustomersTrend: number | null;
  activeGrounds: number;
  activeGroundsTrend: number | null;
  bookingsTodayByGround: { groundId: string; bookings: number }[];
}

/** % change against the same day last week, one decimal; null when last week was 0 (shown as "New"). */
const trend = (now: number, before: number): number | null =>
  before === 0 ? null : Math.round(((now - before) / before) * 1000) / 10;

/** Dashboard home numbers. "Today" is the venue's day. */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async stats(): Promise<DashboardStats> {
    const today = venueNow().date;
    const lastWeek = addDays(today, -7);
    const weekAgo = venueDayStart(addDays(today, -6));
    const [revenue, revenueBefore, bookings, bookingsBefore, customers, customersBefore, grounds, groundsBefore, byGround] = await Promise.all([
      this.revenueOn(today), this.revenueOn(lastWeek),
      this.bookingsOn(today), this.bookingsOn(lastWeek),
      this.prisma.customer.count({ where: { deletedAt: null } }),
      this.prisma.customer.count({ where: { deletedAt: null, createdAt: { lt: weekAgo } } }),
      this.prisma.ground.count({ where: { isActive: true } }),
      this.prisma.ground.count({ where: { isActive: true, createdAt: { lt: weekAgo } } }),
      this.prisma.booking.groupBy({
        by: ['groundId'], where: { deletedAt: null, status: { not: 'cancelled' }, slot: { date: toDbDate(today) } }, _count: { _all: true },
      }),
    ]);
    return {
      todayRevenue: revenue, todayRevenueTrend: trend(revenue, revenueBefore),
      todayBookings: bookings, todayBookingsTrend: trend(bookings, bookingsBefore),
      totalCustomers: customers, totalCustomersTrend: trend(customers, customersBefore),
      activeGrounds: grounds, activeGroundsTrend: trend(grounds, groundsBefore),
      bookingsTodayByGround: byGround.map((g) => ({ groundId: g.groundId, bookings: g._count._all })),
    };
  }

  /** Money received that day minus refunds made that day. */
  private async revenueOn(date: IsoDate): Promise<number> {
    const range = { gte: venueDayStart(date), lt: venueDayStart(addDays(date, 1)) };
    const [received, refunded] = await Promise.all([
      this.prisma.payment.aggregate({ where: { deletedAt: null, status: { in: ['succeeded', 'refunded'] }, createdAt: range }, _sum: { amount: true } }),
      this.prisma.payment.aggregate({ where: { deletedAt: null, status: 'refunded', refundedAt: range }, _sum: { amount: true } }),
    ]);
    return (received._sum.amount ?? 0) - (refunded._sum.amount ?? 0);
  }

  /** Bookings (not cancelled) for slots on that day. */
  private bookingsOn(date: IsoDate): Promise<number> {
    return this.prisma.booking.count({ where: { deletedAt: null, status: { not: 'cancelled' }, slot: { date: toDbDate(date) } } });
  }
}
