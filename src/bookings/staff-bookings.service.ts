import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { env } from '../config/env.js';
import { upsertCustomerByPhone } from '../customers/customer-upsert.js';
import type { PaymentStatus, Prisma, Slot } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { slotInPast, slotNotFound } from '../slots/slot-rules.js';
import { fromDbDate, hasStarted, toDbDate, venueNow } from '../slots/venue-time.js';
import { BookingCancellationService } from './booking-cancellation.service.js';
import { BookingNotifier } from './booking-notifier.service.js';
import {
  bookingNotFound, bookingNotPending, dueOf, paymentStatusOf, slotNotAvailable, withBookingNumber,
} from './booking-rules.js';
import { BOOKING_INCLUDE, toBookingDto, type BookingDto } from './booking.dto.js';
import type {
  CancelBookingInput, ConfirmBookingInput, CreateStaffBookingInput, RecordPaymentInput, UpdateBookingInput,
} from './bookings.schemas.js';

const exceedsDue = (message: string) => new AppError(message, 400, 'PAYMENT_EXCEEDS_DUE');

/** Walk-in and phone bookings made from the dashboard, plus the staff actions on any booking. */
@Injectable()
export class StaffBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cancellation: BookingCancellationService,
    private readonly notifier: BookingNotifier,
  ) {}

  /** Paid in full or in part → confirmed; not paid → pending (the review queue). The slot is booked either way. */
  async create(actorId: string, input: CreateStaffBookingInput): Promise<BookingDto> {
    const slot = await this.prisma.slot.findUnique({ where: { id: input.slotId } });
    if (!slot) throw slotNotFound();
    if (hasStarted(venueNow(), fromDbDate(slot.date), slot.startHour)) throw slotInPast();
    if (slot.status !== 'available') throw slotNotAvailable();
    const paid = paymentAmount(input.payment, slot.price);
    if (input.customer.id && !(await this.prisma.customer.findFirst({ where: { id: input.customer.id, deletedAt: null } }))) {
      throw new AppError('Customer not found', 404, 'CUSTOMER_NOT_FOUND');
    }

    const id = await withBookingNumber((bookingNumber) => this.prisma.$transaction(async (tx) => {
      const { count } = await tx.slot.updateMany({ where: { id: slot.id, status: 'available' }, data: { status: 'booked' } });
      if (count === 0) throw slotNotAvailable();
      const { id: customerId, ...contact } = input.customer;
      const data = newStaffBooking(actorId, input, slot, paid, bookingNumber);
      const booking = await tx.booking.create({
        data: { ...data, customerId: customerId ?? await upsertCustomerByPhone(tx, contact, true) },
      });
      return booking.id;
    }));
    if (paid > 0) await this.notifier.confirmed(id);
    return this.dto(id);
  }

  async confirm(actorId: string, id: string, { markPaid, method, notifyCustomer }: ConfirmBookingInput): Promise<BookingDto> {
    const booking = await this.load(id);
    if (booking.status !== 'pending') throw bookingNotPending();
    if (booking.source === 'portal' && !booking.payAtVenue) throw bookingNotPending('Card bookings are confirmed by their payment');
    const due = dueOf(booking, booking.payments);
    await this.prisma.$transaction(async (tx) => {
      const payments: { amount: number; status: PaymentStatus }[] = [...booking.payments];
      if (markPaid && due > 0) payments.push(await this.addPayment(tx, id, actorId, { amount: due, method }));
      await tx.booking.update({
        where: { id }, data: { status: 'confirmed', confirmedAt: new Date(), paymentStatus: paymentStatusOf(booking.total, payments) },
      });
      await tx.bookingEvent.create({ data: { bookingId: id, type: 'confirmed', userId: actorId, detail: 'Confirmed by staff' } });
    });
    if (notifyCustomer) await this.notifier.confirmed(id);
    return this.dto(id);
  }

  /** Collects some or all of what's due; `partial` becomes `paid` when nothing is left. */
  async recordPayment(actorId: string, id: string, input: RecordPaymentInput): Promise<BookingDto> {
    const booking = await this.load(id);
    if (booking.status === 'cancelled') throw new AppError('This booking is cancelled', 409, 'BOOKING_ALREADY_CANCELLED');
    const due = dueOf(booking, booking.payments);
    if (input.amount > due) throw exceedsDue(`Only ${due} is due on this booking`);
    await this.prisma.$transaction(async (tx) => {
      const payment = await this.addPayment(tx, id, actorId, input);
      await tx.booking.update({ where: { id }, data: { paymentStatus: paymentStatusOf(booking.total, [...booking.payments, payment]) } });
    });
    return this.dto(id);
  }

  async update(id: string, { dueDate, ...rest }: UpdateBookingInput): Promise<BookingDto> {
    await this.load(id);
    await this.prisma.booking.update({
      where: { id }, data: { ...rest, ...(dueDate !== undefined && { dueDate: dueDate ? toDbDate(dueDate) : null }) },
    });
    return this.dto(id);
  }

  async cancel(actorId: string, id: string, input: CancelBookingInput): Promise<BookingDto> {
    await this.load(id);
    await this.cancellation.cancel(id, { actorId, reason: input.reason, refund: input.refund, notify: input.notifyCustomer });
    return this.dto(id);
  }

  async resendConfirmation(id: string): Promise<{ sent: boolean }> {
    const booking = await this.load(id);
    if (booking.status !== 'confirmed' && booking.status !== 'completed') {
      throw new AppError('Only confirmed bookings have a confirmation to send', 409, 'BOOKING_NOT_CONFIRMED');
    }
    return { sent: await this.notifier.confirmed(id) };
  }

  private async addPayment(
    tx: Prisma.TransactionClient, bookingId: string, actorId: string, p: { amount: number; method: 'cash' | 'bank_transfer'; note?: string },
  ) {
    const payment = await tx.payment.create({
      data: { bookingId, method: p.method, amount: p.amount, currency: env.CURRENCY, status: 'succeeded', note: p.note ?? null, recordedById: actorId },
    });
    await tx.bookingEvent.create({
      data: { bookingId, type: 'payment_received', userId: actorId, detail: `Received ${p.amount} by ${p.method.replace('_', ' ')}` },
    });
    return payment;
  }

  private async load(id: string) {
    const booking = await this.prisma.booking.findFirst({ where: { id, deletedAt: null }, include: BOOKING_INCLUDE });
    if (!booking) throw bookingNotFound();
    return booking;
  }

  private async dto(id: string): Promise<BookingDto> {
    return toBookingDto(await this.prisma.booking.findUniqueOrThrow({ where: { id }, include: BOOKING_INCLUDE }));
  }
}

/** The amount received now: all of it, the advance (less than the total), or nothing. */
function paymentAmount(payment: CreateStaffBookingInput['payment'], total: number): number {
  if (payment.type === 'none') return 0;
  if (payment.type === 'full') return total;
  if (payment.amount! >= total) throw exceedsDue('An advance must be less than the total; record it as a full payment');
  return payment.amount!;
}

function newStaffBooking(actorId: string, input: CreateStaffBookingInput, slot: Slot, paid: number, bookingNumber: string) {
  const { payment, customer } = input;
  const events: Prisma.BookingEventCreateWithoutBookingInput[] = [{ type: 'created', detail: 'Booked by staff', user: { connect: { id: actorId } } }];
  if (paid > 0) {
    events.push(
      { type: 'payment_received', detail: `Received ${paid} by ${payment.method!.replace('_', ' ')}`, user: { connect: { id: actorId } } },
      { type: 'confirmed', detail: 'Confirmed on booking', user: { connect: { id: actorId } } },
    );
  }
  return {
    bookingNumber, source: 'staff' as const, groundId: slot.groundId, slotId: slot.id, liveSlotId: slot.id,
    contactName: customer.name, contactEmail: customer.email, contactPhone: customer.phone,
    status: paid > 0 ? 'confirmed' as const : 'pending' as const,
    paymentStatus: paid === 0 ? 'unpaid' as const : paid >= slot.price ? 'paid' as const : 'partial' as const,
    confirmedAt: paid > 0 ? new Date() : null,
    amount: slot.price, serviceFee: 0, total: slot.price,
    dueDate: payment.type === 'partial' && payment.dueDate ? toDbDate(payment.dueDate) : null,
    dueNote: payment.type === 'partial' ? (payment.note ?? null) : null,
    notes: input.notes ?? null, createdById: actorId,
    payments: paid > 0
      ? { create: [{ method: payment.method!, amount: paid, currency: env.CURRENCY, status: 'succeeded' as const, note: payment.note ?? null, recordedById: actorId }] }
      : undefined,
    events: { create: events },
  };
}
