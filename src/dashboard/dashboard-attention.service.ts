import { Injectable } from '@nestjs/common';
import { isDueToday, isOverdue, loadOwing, type OwingBooking } from '../bookings/booking-due.js';
import { CARD_CHECKOUT_IN_PROGRESS, WALLET_UNDER_REVIEW } from '../bookings/booking-rules.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { slotHour } from '../slots/slot-time.js';
import { addDays, fromDbDate, minutesUntil, toDbDate, venueNow } from '../slots/venue-time.js';
import { loadNeedsOutcome, type NeedsOutcome } from './needs-outcome.js';

const SOON_MINUTES = 60;

export interface DashboardAttention {
  toConfirm: { count: number; payAtVenue: number };
  /** bKash / Nagad payments staff must check in their app (also counted in toConfirm). Not money owed. */
  toVerify: { count: number };
  overdue: { count: number; amount: number };
  dueToday: { count: number; amount: number };
  payingNow: { count: number };
  startingSoon: { count: number; withinMinutes: number };
  /** Still pending after the slot ended: collect, verify, or mark no-show. */
  needsOutcome: NeedsOutcome;
}

const sumDue = (list: OwingBooking[]) => ({ count: list.length, amount: list.reduce((sum, b) => sum + b.due, 0) });

/** The dashboard's "needs attention" cards: what staff should act on now. Venue time throughout. */
@Injectable()
export class DashboardAttentionService {
  constructor(private readonly prisma: PrismaService) {}

  async attention(): Promise<DashboardAttention> {
    const now = venueNow();
    const [pending, owing, held, nearby, toVerify, needsOutcome] = await Promise.all([
      // Unpaid staff bookings and pay-at-venue requests; card checkouts confirm themselves.
      this.prisma.booking.findMany({ where: { deletedAt: null, status: 'pending', NOT: CARD_CHECKOUT_IN_PROGRESS }, select: { payAtVenue: true } }),
      loadOwing(this.prisma),
      // One card checkout holds up to 4 slots: count the checkouts, not the slots.
      this.prisma.slot.findMany({ where: { status: 'held' }, select: { heldByBookingId: true }, distinct: ['heldByBookingId'] }),
      // Today and tomorrow, so "within the hour" works across midnight.
      this.prisma.booking.findMany({
        where: {
          deletedAt: null, status: { in: ['pending', 'confirmed'] }, NOT: CARD_CHECKOUT_IN_PROGRESS,
          slot: { date: { in: [toDbDate(now.date), toDbDate(addDays(now.date, 1))] } },
        },
        select: { slot: { select: { date: true, startHour: true, startMinute: true } } },
      }),
      this.prisma.booking.count({ where: { deletedAt: null, ...WALLET_UNDER_REVIEW } }),
      loadNeedsOutcome(this.prisma, now),
    ]);
    const soon = nearby.filter(({ slot }) => {
      const minutes = minutesUntil(now, fromDbDate(slot.date), slotHour(slot));
      return minutes > 0 && minutes <= SOON_MINUTES;
    });
    return {
      toConfirm: { count: pending.length, payAtVenue: pending.filter((b) => b.payAtVenue).length },
      toVerify: { count: toVerify },
      overdue: sumDue(owing.filter((b) => isOverdue(b, now))),
      dueToday: sumDue(owing.filter((b) => isDueToday(b, now))),
      payingNow: { count: held.length },
      startingSoon: { count: soon.length, withinMinutes: SOON_MINUTES },
      needsOutcome,
    };
  }
}
