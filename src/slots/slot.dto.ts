import type { BlockReason, BookingPaymentStatus, Prisma, SlotStatus } from '../generated/prisma/client.js';
import { slotTimes, type SlotTimes } from './slot-time.js';
import { fromDbDate, type IsoDate } from './venue-time.js';

/** Joins every admin slot query needs. */
export const SLOT_INCLUDE = {
  ground: { select: { name: true } },
  blockedBy: { select: { id: true, name: true } },
  /** The live booking (pending, confirmed or completed), if any. */
  bookings: {
    where: { liveSlotId: { not: null } },
    take: 1,
    select: {
      id: true, bookingNumber: true, paymentStatus: true, total: true, contactName: true, contactPhone: true,
      payments: { where: { deletedAt: null }, select: { amount: true, status: true } },
    },
  },
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

export const toSlotDto = (s: SlotRow): SlotDto => ({
  id: s.id,
  groundId: s.groundId,
  groundName: s.ground.name,
  date: fromDbDate(s.date),
  ...slotTimes(s),
  durationMinutes: s.durationMinutes,
  price: s.price,
  status: s.status,
  booking: s.bookings[0]
    ? { id: s.bookings[0].id, bookingNumber: s.bookings[0].bookingNumber, customerName: s.bookings[0].contactName, paymentStatus: s.bookings[0].paymentStatus }
    : null,
  heldUntil: s.status === 'held' ? s.heldUntil : null,
  block: s.status === 'blocked' && s.blockReason && s.blockedAt
    ? { reason: s.blockReason, note: s.blockNote, blockedBy: s.blockedBy, blockedAt: s.blockedAt }
    : null,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});
