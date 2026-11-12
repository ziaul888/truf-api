import { CARD_CHECKOUT_IN_PROGRESS, isWalletMethod, owedOf, paidOf } from '../bookings/booking-rules.js';
import { currentSlots, windowHasEnded, windowOf, windowTimes } from '../bookings/booking-slots.js';
import type { PaymentMethod, PaymentStatus } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { slotTimes, type SlotTimes } from '../slots/slot-time.js';
import { fromDbDate, toDbDate, type IsoDate, type VenueNow } from '../slots/venue-time.js';

const SLOT_CLOCK = { id: true, date: true, startHour: true, startMinute: true, durationMinutes: true } as const;

/** The card lists this many; `count` has them all. */
export const NEEDS_OUTCOME_LIMIT = 10;

export interface NeedsOutcomeBooking {
  id: string;
  bookingNumber: string;
  customerName: string;
  groundName: string;
  slot: { date: IsoDate } & SlotTimes;
  /** Each actual slot, preserving gaps between nonconsecutive times. */
  slots: ({ date: IsoDate } & SlotTimes)[];
  total: number;
  /** Received so far: what stays if staff mark it no-show. */
  paid: number;
  /** Owed (0 while a bKash / Nagad payment is under review). */
  due: number;
  payAtVenue: boolean;
  /** The bKash / Nagad payment sent at checkout; `pending` means staff verify or reject it first. */
  walletPayment: { method: PaymentMethod; status: PaymentStatus } | null;
}

export interface NeedsOutcome {
  count: number;
  /** Most recently ended first, at most NEEDS_OUTCOME_LIMIT. */
  bookings: NeedsOutcomeBooking[];
}

/**
 * Bookings still pending after their slot ended: staff should record what happened (collect the
 * payment, which confirms it, verify a bKash / Nagad payment, or mark it no-show). Card checkouts
 * still in Stripe are left out; they confirm or lapse on their own.
 */
export async function loadNeedsOutcome(prisma: PrismaService, now: VenueNow): Promise<NeedsOutcome> {
  const rows = await prisma.booking.findMany({
    where: { deletedAt: null, status: 'pending', NOT: CARD_CHECKOUT_IN_PROGRESS, slot: { date: { lte: toDbDate(now.date) } } },
    select: {
      id: true, bookingNumber: true, contactName: true, status: true, total: true, payAtVenue: true,
      ground: { select: { name: true } },
      slot: { select: SLOT_CLOCK },
      bookingSlots: { select: { price: true, cancelledAt: true, slot: { select: SLOT_CLOCK } } },
      payments: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { amount: true, status: true, method: true, payerNumber: true } },
    },
    orderBy: [{ slot: { date: 'desc' } }, { slot: { startHour: 'desc' } }, { slot: { startMinute: 'desc' } }],
  });
  // Sort by the last slot's end, rather than the primary slot's start.
  const ended = rows.filter((b) => windowHasEnded(now, windowOf(b))).sort((a, b) => {
    const first = windowOf(a);
    const second = windowOf(b);
    return second.date.localeCompare(first.date) || second.endMinutes - first.endMinutes;
  });
  return {
    count: ended.length,
    bookings: ended.slice(0, NEEDS_OUTCOME_LIMIT).map((b) => {
      const wallet = b.payments.findLast((p) => isWalletMethod(p.method) && p.payerNumber !== null);
      return {
        id: b.id, bookingNumber: b.bookingNumber, customerName: b.contactName, groundName: b.ground.name,
        slot: { date: windowOf(b).date, ...windowTimes(windowOf(b)) },
        slots: currentSlots(b).map(({ slot }) => ({ date: fromDbDate(slot.date), ...slotTimes(slot) })),
        total: b.total, paid: paidOf(b.payments), due: owedOf(b, b.payments), payAtVenue: b.payAtVenue,
        walletPayment: wallet ? { method: wallet.method, status: wallet.status } : null,
      };
    }),
  };
}
