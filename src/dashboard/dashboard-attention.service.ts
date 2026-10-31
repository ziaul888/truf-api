import { Injectable } from '@nestjs/common';
import { isDueToday, isOverdue, loadOwing, type OwingBooking } from '../bookings/booking-due.js';
import { CARD_CHECKOUT_IN_PROGRESS } from '../bookings/booking-rules.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addDays, fromDbDate, minutesUntil, toDbDate, venueNow } from '../slots/venue-time.js';

const SOON_MINUTES = 60;

export interface DashboardAttention {
  toConfirm: { count: number; payAtVenue: number };
  overdue: { count: number; amount: number };
  dueToday: { count: number; amount: number };
  payingNow: { count: number };
  startingSoon: { count: number; withinMinutes: number };
}

const sumDue = (list: OwingBooking[]) => ({ count: list.length, amount: list.reduce((sum, b) => sum + b.due, 0) });

/** The dashboard's "needs attention" cards: what staff should act on now. Venue time throughout. */
@Injectable()
export class DashboardAttentionService {
  constructor(private readonly prisma: PrismaService) {}

  async attention(): Promise<DashboardAttention> {
    const now = venueNow();
    const [pending, owing, held, nearby] = await Promise.all([
      // Unpaid staff bookings and pay-at-venue requests; card checkouts confirm themselves.
      this.prisma.booking.findMany({ where: { deletedAt: null, status: 'pending', NOT: CARD_CHECKOUT_IN_PROGRESS }, select: { payAtVenue: true } }),
      loadOwing(this.prisma),
      this.prisma.slot.count({ where: { status: 'held' } }),
      // Today and tomorrow, so "within the hour" works across midnight.
      this.prisma.booking.findMany({
        where: {
          deletedAt: null, status: { in: ['pending', 'confirmed'] }, NOT: CARD_CHECKOUT_IN_PROGRESS,
          slot: { date: { in: [toDbDate(now.date), toDbDate(addDays(now.date, 1))] } },
        },
        select: { slot: { select: { date: true, startHour: true } } },
      }),
    ]);
    const soon = nearby.filter(({ slot }) => {
      const minutes = minutesUntil(now, fromDbDate(slot.date), slot.startHour);
      return minutes > 0 && minutes <= SOON_MINUTES;
    });
    return {
      toConfirm: { count: pending.length, payAtVenue: pending.filter((b) => b.payAtVenue).length },
      overdue: sumDue(owing.filter((b) => isOverdue(b, now))),
      dueToday: sumDue(owing.filter((b) => isDueToday(b, now))),
      payingNow: { count: held },
      startingSoon: { count: soon.length, withinMinutes: SOON_MINUTES },
    };
  }
}
