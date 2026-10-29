import type {
  BookingEventType, BookingPaymentStatus, BookingSource, BookingStatus, PaymentMethod, PaymentStatus, Prisma, Sport,
} from '../generated/prisma/client.js';
import { photoUrl } from '../grounds/photo-storage.js';
import { endHourOf } from '../slots/slot.dto.js';
import { fromDbDate, minutesUntil, type IsoDate, type VenueNow } from '../slots/venue-time.js';
import { dueOf, paidOf } from './booking-rules.js';

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

/** What the dashboard sees. */
export interface BookingDto {
  id: string;
  bookingNumber: string;
  source: BookingSource;
  status: BookingStatus;
  paymentStatus: BookingPaymentStatus;
  /** Portal customer chose to pay cash at the venue. */
  payAtVenue: boolean;
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
  ground: { id: string; name: string; sport: Sport; format: string | null; address: string | null; coverPhoto: string | null };
  slot: Omit<BookingSlotDto, 'id'>;
  amount: number;
  serviceFee: number;
  total: number;
  paid: number;
  due: number;
  createdAt: Date;
  cancelledAt: Date | null;
  /** True when the customer can still cancel through the link (portal bookings outside the cutoff). */
  canCancel: boolean;
  /** True when something is due and the customer can pay it by card through the link ("Pay now"). */
  canPay: boolean;
}

const slotOf = (s: BookingRow['slot']): BookingSlotDto => ({
  id: s.id, date: fromDbDate(s.date), startHour: s.startHour, endHour: endHourOf(s),
});

export const toBookingDto = (b: BookingRow): BookingDto => ({
  id: b.id, bookingNumber: b.bookingNumber, source: b.source, status: b.status, paymentStatus: b.paymentStatus,
  payAtVenue: b.payAtVenue,
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
    stripePaymentIntentId: p.stripePaymentIntentId, note: p.note, recordedBy: p.recordedBy,
    createdAt: p.createdAt, refundedAt: p.refundedAt,
  })),
  events: b.events.map((e) => ({ id: e.id, type: e.type, detail: e.detail, user: e.user, createdAt: e.createdAt })),
});

/**
 * Whether the customer can pay what's due through the link: anything owed on a live booking.
 * A portal card checkout still in progress uses "Complete payment" instead.
 */
export const customerCanPay = (b: BookingRow) =>
  b.status !== 'cancelled' && dueOf(b, b.payments) > 0
  && !(b.source === 'portal' && !b.payAtVenue && b.status === 'pending');

/** Whether a customer may cancel through the signed link right now. */
export const customerCanCancel = (b: BookingRow, now: VenueNow, cutoffHours: number) =>
  b.source === 'portal' && (b.status === 'confirmed' || b.status === 'pending')
  && minutesUntil(now, fromDbDate(b.slot.date), b.slot.startHour) > cutoffHours * 60;

export const toPublicBookingDto = (b: BookingRow, canCancel: boolean, canPay: boolean): PublicBookingDto => {
  const { id: _slotId, ...slot } = slotOf(b.slot);
  const cover = b.ground.photos[0];
  return {
    id: b.id, bookingNumber: b.bookingNumber, status: b.status, paymentStatus: b.paymentStatus, payAtVenue: b.payAtVenue,
    ground: {
      id: b.ground.id, name: b.ground.name, sport: b.ground.sport, format: b.ground.format, address: b.ground.address,
      coverPhoto: cover ? photoUrl(b.ground.id, cover) : null,
    },
    slot,
    amount: b.amount, serviceFee: b.serviceFee, total: b.total, paid: paidOf(b.payments), due: dueOf(b, b.payments),
    createdAt: b.createdAt, cancelledAt: b.cancelledAt, canCancel, canPay,
  };
};
