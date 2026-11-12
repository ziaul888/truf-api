import type { BlockReason, BookingPaymentStatus, Prisma, SlotStatus } from '../generated/prisma/client.js';
import { slotTimes, type SlotTimes } from './slot-time.js';
import { fromDbDate, type IsoDate } from './venue-time.js';

const LIVE_BOOKING_SELECT = {
  id: true, bookingNumber: true, paymentStatus: true, total: true, contactName: true, contactPhone: true,
  _count: { select: { bookingSlots: true } },
  payments: { where: { deletedAt: null }, select: { amount: true, status: true } },
} satisfies Prisma.BookingSelect;

/** Joins every admin slot query needs. */
export const SLOT_INCLUDE = {
  ground: { select: { name: true } },
  blockedBy: { select: { id: true, name: true } },
  /** The live booking (pending, confirmed or completed) holding this slot, if any: through its BookingSlot, so any slot of a multi-slot booking has it. */
  bookingSlots: { where: { liveSlotId: { not: null }, booking: { status: { not: 'cancelled' } } }, take: 1, select: { booking: { select: LIVE_BOOKING_SELECT } } },
  /** Bookings made by an older release (during a deploy) have no BookingSlot yet: found through their primary slot. */
  bookings: { where: { liveSlotId: { not: null } }, take: 1, select: LIVE_BOOKING_SELECT },
} satisfies Prisma.SlotInclude;

export type SlotRow = Prisma.SlotGetPayload<{ include: typeof SLOT_INCLUDE }>;

export interface SlotBlockDto {
  reason: BlockReason;
  note: string | null;
  /** Null if that staff account no longer exists. */
  blockedBy: { id: string; name: string } | null;
  blockedAt: Date;
}

export interface SlotBookingDto {
  id: string;
  bookingNumber: string;
  customerName: string;
  paymentStatus: BookingPaymentStatus;
}

/** What the dashboard sees. */
export interface SlotDto extends SlotTimes {
  id: string;
  groundId: string;
  groundName: string;
  date: IsoDate;
  durationMinutes: number;
  price: number;
  status: SlotStatus;
  /** The booking holding or booking this slot. */
  booking: SlotBookingDto | null;
  /** While status = held: when the checkout hold lapses. */
  heldUntil: Date | null;
  block: SlotBlockDto | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What customers see: no status reason, no booking or block details. */
export interface PublicSlotDto extends SlotTimes {
  id: string;
  date: IsoDate;
  price: number;
  isPeak: boolean;
  available: boolean;
}

/** The live booking holding the slot, if any. */
export const liveBookingOf = (s: SlotRow) => s.bookingSlots[0]?.booking ?? s.bookings[0];

function bookingOf(s: SlotRow): SlotBookingDto | null {
  const b = liveBookingOf(s);
  return b ? { id: b.id, bookingNumber: b.bookingNumber, customerName: b.contactName, paymentStatus: b.paymentStatus } : null;
}

export const toSlotDto = (s: SlotRow): SlotDto => ({
  id: s.id,
  groundId: s.groundId,
  groundName: s.ground.name,
  date: fromDbDate(s.date),
  ...slotTimes(s),
  durationMinutes: s.durationMinutes,
  price: s.price,
  status: s.status,
  booking: bookingOf(s),
  heldUntil: s.status === 'held' ? s.heldUntil : null,
  block: s.status === 'blocked' && s.blockReason && s.blockedAt
    ? { reason: s.blockReason, note: s.blockNote, blockedBy: s.blockedBy, blockedAt: s.blockedAt }
    : null,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});
