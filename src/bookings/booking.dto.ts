import type {
  BookingEventType, BookingPaymentStatus, BookingSource, BookingStatus, PaymentMethod, PaymentStatus, Prisma, Sport,
} from '../generated/prisma/client.js';
import { photoUrl } from '../grounds/photo-storage.js';
import { endHourOf } from '../slots/slot.dto.js';
import { fromDbDate, minutesUntil, type IsoDate, type VenueNow } from '../slots/venue-time.js';
import { dueOf, isUnderReview, isWalletMethod, paidOf, type WalletMethod } from './booking-rules.js';

const STAFF = { select: { id: true, name: true } } as const;

/** Joins every booking response needs. */
export const BOOKING_INCLUDE = {
  ground: { select: { id: true, name: true, sport: true, format: true, address: true, photos: true } },
  slot: { select: { id: true, date: true, startHour: true, durationMinutes: true } },
  customer: { select: { id: true, name: true, phone: true, email: true } },
  payments: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' }, include: { recordedBy: STAFF } },
  createdBy: STAFF,
} satisfies Prisma.BookingInclude;

export const BOOKING_DETAIL_INCLUDE = {
  ...BOOKING_INCLUDE,
  events: { orderBy: { createdAt: 'desc' }, include: { user: STAFF } },
} satisfies Prisma.BookingInclude;

export type BookingRow = Prisma.BookingGetPayload<{ include: typeof BOOKING_INCLUDE }>;
export type BookingDetailRow = Prisma.BookingGetPayload<{ include: typeof BOOKING_DETAIL_INCLUDE }>;

type Staff = { id: string; name: string } | null;

export interface BookingSlotDto {
  id: string;
  date: IsoDate;
  startHour: number;
  endHour: number;
}

/** A bKash / Nagad payment the customer sent from the portal checkout (it has the sender's number). */
export interface WalletPaymentDto {
  method: WalletMethod;
  amount: number;
  /** The TrxID. */
  reference: string | null;
  payerNumber: string;
  /** `pending` until staff verify it; `failed` when rejected or cancelled first. */
  status: PaymentStatus;
}

/** What the dashboard sees. */
export interface BookingDto {
  id: string;
  bookingNumber: string;
  source: BookingSource;
  status: BookingStatus;
  paymentStatus: BookingPaymentStatus;
  /** Portal customer chose to pay cash at the venue. */
  payAtVenue: boolean;
  /** Portal customer paid by bKash / Nagad: what they sent, for staff to verify. Null otherwise. */
  walletPayment: WalletPaymentDto | null;
  /** The customer asked to cancel while their bKash / Nagad payment was under review ("Cancel requested"). */
  cancelRequestedAt: Date | null;
  ground: { id: string; name: string; sport: Sport };
  slot: BookingSlotDto;
  customer: { id: string; name: string; phone: string | null; email: string };
  /** The details given for this booking (may differ from the customer record). */
  contact: { name: string; email: string; phone: string };
  amount: number;
  serviceFee: number;
  total: number;
  paid: number;
  due: number;
  dueDate: IsoDate | null;
  dueNote: string | null;
  notes: string | null;
  createdBy: Staff;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentDto {
  id: string;
  method: PaymentMethod;
  amount: number;
  status: PaymentStatus;
  cardLast4: string | null;
  stripePaymentIntentId: string | null;
  /** bKash / Nagad TrxID. */
  reference: string | null;
  /** bKash / Nagad: the number the customer sent from (portal payments). */
  payerNumber: string | null;
  note: string | null;
  recordedBy: Staff;
  createdAt: Date;
  refundedAt: Date | null;
}

export interface BookingEventDto {
  id: string;
  type: BookingEventType;
  detail: string | null;
  user: Staff;
  createdAt: Date;
}

export interface BookingDetailDto extends BookingDto {
  customer: BookingDto['customer'] & { totalBookings: number };
  payments: PaymentDto[];
  events: BookingEventDto[];
}

/** What a customer sees through their signed link: no staff notes, no other customers' data. */
export interface PublicBookingDto {
  id: string;
  bookingNumber: string;
  status: BookingStatus;
  paymentStatus: BookingPaymentStatus;
  payAtVenue: boolean;
  /** Paid by bKash / Nagad at checkout; `status: pending` while the venue verifies it. */
  walletPayment: Omit<WalletPaymentDto, 'payerNumber'> | null;
  ground: { id: string; name: string; sport: Sport; format: string | null; address: string | null; coverPhoto: string | null };
  slot: Omit<BookingSlotDto, 'id'>;
  amount: number;
  serviceFee: number;
  total: number;
  paid: number;
  due: number;
  createdAt: Date;
  cancelledAt: Date | null;
  /** True when the customer can still cancel through the link (portal bookings outside the cutoff, not under review). */
  canCancel: boolean;
  /** The customer asked to cancel while the venue verifies their bKash / Nagad payment. */
  cancelRequested: boolean;
  /** True when they can ask now: payment under review, no request yet, outside the cutoff. */
  canRequestCancel: boolean;
  /** True when something is due and the customer can pay it by card through the link ("Pay now"). */
  canPay: boolean;
}

const slotOf = (s: BookingRow['slot']): BookingSlotDto => ({
  id: s.id, date: fromDbDate(s.date), startHour: s.startHour, endHour: endHourOf(s),
});

/** The latest wallet payment sent from the portal (staff-recorded ones have no sender number). */
const walletPaymentOf = (b: BookingRow): WalletPaymentDto | null => {
  const p = b.payments.findLast((x) => isWalletMethod(x.method) && x.payerNumber !== null);
  return p && isWalletMethod(p.method)
    ? { method: p.method, amount: p.amount, reference: p.reference, payerNumber: p.payerNumber!, status: p.status }
    : null;
};

export const toBookingDto = (b: BookingRow): BookingDto => ({
  id: b.id, bookingNumber: b.bookingNumber, source: b.source, status: b.status, paymentStatus: b.paymentStatus,
  payAtVenue: b.payAtVenue, walletPayment: walletPaymentOf(b), cancelRequestedAt: b.cancelRequestedAt,
  ground: { id: b.ground.id, name: b.ground.name, sport: b.ground.sport },
  slot: slotOf(b.slot),
  customer: b.customer,
  contact: { name: b.contactName, email: b.contactEmail, phone: b.contactPhone },
  amount: b.amount, serviceFee: b.serviceFee, total: b.total,
  paid: paidOf(b.payments), due: dueOf(b, b.payments),
  dueDate: b.dueDate ? fromDbDate(b.dueDate) : null, dueNote: b.dueNote, notes: b.notes,
  createdBy: b.createdBy, confirmedAt: b.confirmedAt, cancelledAt: b.cancelledAt, cancelReason: b.cancelReason,
  createdAt: b.createdAt, updatedAt: b.updatedAt,
});

export const toBookingDetailDto = (b: BookingDetailRow, totalBookings: number): BookingDetailDto => ({
  ...toBookingDto(b),
  customer: { ...b.customer, totalBookings },
  payments: b.payments.map((p) => ({
    id: p.id, method: p.method, amount: p.amount, status: p.status, cardLast4: p.cardLast4,
    stripePaymentIntentId: p.stripePaymentIntentId, reference: p.reference, payerNumber: p.payerNumber, note: p.note, recordedBy: p.recordedBy,
    createdAt: p.createdAt, refundedAt: p.refundedAt,
  })),
  events: b.events.map((e) => ({ id: e.id, type: e.type, detail: e.detail, user: e.user, createdAt: e.createdAt })),
});

/**
 * Whether the customer can pay what's due through the link: anything owed on a live booking.
 * A portal card checkout still in progress uses "Complete payment" instead, and a bKash / Nagad
 * payment the venue is still verifying is not paid twice.
 */
export const customerCanPay = (b: BookingRow) =>
  b.status !== 'cancelled' && dueOf(b, b.payments) > 0 && !isUnderReview(b, b.payments)
  && !(b.source === 'portal' && !b.payAtVenue && b.status === 'pending');

const outsideCutoff = (b: BookingRow, now: VenueNow, cutoffHours: number) =>
  minutesUntil(now, fromDbDate(b.slot.date), b.slot.startHour) > cutoffHours * 60;

/** Whether a customer may cancel through the signed link right now (not while a wallet payment is under review). */
export const customerCanCancel = (b: BookingRow, now: VenueNow, cutoffHours: number) =>
  b.source === 'portal' && (b.status === 'confirmed' || b.status === 'pending') && !isUnderReview(b, b.payments)
  && outsideCutoff(b, now, cutoffHours);

/** While staff verify a bKash / Nagad payment, the customer may ask to cancel instead, once, outside the cutoff. */
export const customerCanRequestCancel = (b: BookingRow, now: VenueNow, cutoffHours: number) =>
  b.source === 'portal' && isUnderReview(b, b.payments) && b.cancelRequestedAt === null && outsideCutoff(b, now, cutoffHours);

export const toPublicBookingDto = (b: BookingRow, canCancel: boolean, canPay: boolean, canRequestCancel = false): PublicBookingDto => {
  const { id: _slotId, ...slot } = slotOf(b.slot);
  const cover = b.ground.photos[0];
  const wallet = walletPaymentOf(b);
  return {
    id: b.id, bookingNumber: b.bookingNumber, status: b.status, paymentStatus: b.paymentStatus, payAtVenue: b.payAtVenue,
    walletPayment: wallet && { method: wallet.method, amount: wallet.amount, reference: wallet.reference, status: wallet.status },
    ground: {
      id: b.ground.id, name: b.ground.name, sport: b.ground.sport, format: b.ground.format, address: b.ground.address,
      coverPhoto: cover ? photoUrl(b.ground.id, cover) : null,
    },
    slot,
    amount: b.amount, serviceFee: b.serviceFee, total: b.total, paid: paidOf(b.payments), due: dueOf(b, b.payments),
    createdAt: b.createdAt, cancelledAt: b.cancelledAt, canCancel, canPay,
    cancelRequested: b.cancelRequestedAt !== null, canRequestCancel,
  };
};
