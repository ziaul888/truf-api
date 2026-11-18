import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { env } from '../config/env.js';
import {
  contactEmailOf,
  upsertCustomerByPhone,
} from '../customers/customer-upsert.js';
import type {
  PaymentStatus,
  Prisma,
  Slot,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SlotSettingsService } from '../slots/slot-settings.service.js';
import { toDbDate, venueNow } from '../slots/venue-time.js';
import { BookingCancellationService } from './booking-cancellation.service.js';
import { BookingNotifier } from './booking-notifier.service.js';
import {
  bookingChanged,
  bookingNotFound,
  bookingNotPending,
  dueOf,
  methodName,
  noShowDetail,
  paymentStatusOf,
  paymentUnderReview,
  pendingWalletPayment,
  receivedDetail,
  withBookingNumber,
  withUniqueReference,
} from './booking-rules.js';
import { REFUND_DUE } from './refund-tracking.js';
import { slotLimitOf } from './booking-limits.js';
import { sumPrice } from './booking-slots.js';
import {
  BOOKING_INCLUDE,
  toBookingDto,
  type BookingDto,
} from './booking.dto.js';
import {
  assertCanMarkNoShow,
  bookingNoShow,
  undoneStatusOf,
} from './no-show-rules.js';
import { claimSlots } from './checkout-slots.js';
import { loadStaffSlots, staffSlotIds } from './staff-booking-slots.js';
import { verifyWalletPayment } from './wallet-verification.js';
import type {
  CancelBookingInput,
  ConfirmBookingInput,
  CreateStaffBookingInput,
  NoShowInput,
  RecordPaymentInput,
  RefundSentInput,
  UpdateBookingInput,
} from './bookings.schemas.js';

const exceedsDue = (message: string) =>
  new AppError(message, 400, 'PAYMENT_EXCEEDS_DUE');

type StaffPayment = {
  amount: number;
  method: RecordPaymentInput['method'];
  reference?: string;
  note?: string;
};
type PaymentLike = { amount: number; status: PaymentStatus };

/** Walk-in and phone bookings made from the dashboard, plus the staff actions on any booking. */
@Injectable()
export class StaffBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cancellation: BookingCancellationService,
    private readonly notifier: BookingNotifier,
    private readonly settings: SlotSettingsService,
  ) {}

  /**
   * Paid in full or in part → confirmed; not paid → pending (the review queue). The slot is booked
   * either way. Open until the slot ends, so a team walking in just after the start can still play.
   * One booking can hold several slots (`slotIds`, at most the slot settings' limit) of one ground and date; the
   * payment is against their combined total.
   * Email optional: left blank, the customer's stored one is used, else no customer emails are sent.
   */
  async create(
    actorId: string,
    input: CreateStaffBookingInput,
  ): Promise<BookingDto> {
    const ids = staffSlotIds(input);
    const max = ids.length > 1 ? slotLimitOf(await this.settings.get()) : 1;
    const slots = await loadStaffSlots(this.prisma, ids, max);
    const total = sumPrice(slots);
    const paid = paymentAmount(input.payment, total);
    if (
      input.customer.id &&
      !(await this.prisma.customer.findFirst({
        where: { id: input.customer.id, deletedAt: null },
      }))
    ) {
      throw new AppError('Customer not found', 404, 'CUSTOMER_NOT_FOUND');
    }

    const id = await withBookingNumber((bookingNumber) =>
      this.prisma.$transaction(async (tx) => {
        await claimSlots(tx, slots, { status: 'booked' });
        const { id, ...contact } = input.customer;
        const customerId =
          id ?? (await upsertCustomerByPhone(tx, contact, true));
        const contactEmail = await contactEmailOf(
          tx,
          customerId,
          contact.email,
        );
        const booking = await tx.booking.create({
          data: {
            ...newStaffBooking(actorId, input, slots, paid, bookingNumber),
            customerId,
            contactEmail,
          },
        });
        return booking.id;
      }),
    );
    if (paid > 0) await this.notifier.confirmed(id);
    return this.dto(id);
  }

  /**
   * Confirms a pending booking. For a bKash / Nagad booking this is "Verify": staff have found the
   * money in their own app, so the pending wallet payment becomes succeeded first.
   */
  async confirm(
    actorId: string,
    id: string,
    { markPaid, method, reference, notifyCustomer }: ConfirmBookingInput,
  ): Promise<BookingDto> {
    const booking = await this.load(id);
    if (booking.status !== 'pending') throw bookingNotPending();
    const wallet = pendingWalletPayment(booking.payments);
    if (booking.source === 'portal' && !booking.payAtVenue && !wallet)
      throw bookingNotPending('Card bookings are confirmed by their payment');
    await withUniqueReference(() =>
      this.prisma.$transaction(async (tx) => {
        const payments: PaymentLike[] = wallet
          ? await verifyWalletPayment(tx, booking, actorId)
          : [...booking.payments];
        const due = dueOf(booking, payments);
        if (markPaid && due > 0)
          payments.push(
            await this.addPayment(tx, id, actorId, {
              amount: due,
              method,
              reference,
            }),
          );
        // Only while still pending: a Reject or customer cancel that got in first wins (409, rolled back).
        const { count } = await tx.booking.updateMany({
          where: { id, status: 'pending' },
          data: {
            status: 'confirmed',
            confirmedAt: new Date(),
            paymentStatus: paymentStatusOf(booking.total, payments),
          },
        });
        if (count === 0) throw bookingChanged();
        await tx.bookingEvent.create({
          data: {
            bookingId: id,
            type: 'confirmed',
            userId: actorId,
            detail: wallet ? 'Payment verified by staff' : 'Confirmed by staff',
          },
        });
      }),
    );
    if (notifyCustomer) await this.notifier.confirmed(id);
    return this.dto(id);
  }

  /**
   * Collects some or all of what's due; `partial` becomes `paid` when nothing is left. Money taken on a
   * pending booking confirms it, the same as a staff booking made with a payment.
   */
  async recordPayment(
    actorId: string,
    id: string,
    input: RecordPaymentInput,
  ): Promise<BookingDto> {
    const booking = await this.load(id);
    if (booking.status === 'cancelled')
      throw new AppError(
        'This booking is cancelled',
        409,
        'BOOKING_ALREADY_CANCELLED',
      );
    if (booking.status === 'no_show')
      throw bookingNoShow(
        'This booking is marked no-show. Undo the no-show to collect a payment',
      );
    if (pendingWalletPayment(booking.payments)) {
      throw paymentUnderReview(
        'A bKash / Nagad payment on this booking is waiting to be verified. Verify or reject it first',
      );
    }
    if (
      booking.status === 'pending' &&
      booking.source === 'portal' &&
      !booking.payAtVenue
    ) {
      throw bookingNotPending(
        'The customer is paying this booking by card. Wait for the card payment, or cancel it',
      );
    }
    const due = dueOf(booking, booking.payments);
    if (input.amount > due)
      throw exceedsDue(`Only ${due} is due on this booking`);
    const confirms = booking.status === 'pending';
    await withUniqueReference(() =>
      this.prisma.$transaction(async (tx) => {
        const payment = await this.addPayment(tx, id, actorId, input);
        const paymentStatus = paymentStatusOf(booking.total, [
          ...booking.payments,
          payment,
        ]);
        // From the status it was read in: a cancel that got in first wins (409, rolled back).
        const { count } = await tx.booking.updateMany({
          where: { id, status: booking.status },
          data: {
            paymentStatus,
            ...(confirms && { status: 'confirmed', confirmedAt: new Date() }),
          },
        });
        if (count === 0) throw bookingChanged();
        if (confirms)
          await tx.bookingEvent.create({
            data: {
              bookingId: id,
              type: 'confirmed',
              userId: actorId,
              detail: 'Confirmed on payment',
            },
          });
      }),
    );
    if (confirms) await this.notifier.confirmed(id);
    return this.dto(id);
  }

  async update(
    id: string,
    { dueDate, ...rest }: UpdateBookingInput,
  ): Promise<BookingDto> {
    await this.load(id);
    await this.prisma.booking.update({
      where: { id },
      data: {
        ...rest,
        ...(dueDate !== undefined && {
          dueDate: dueDate ? toDbDate(dueDate) : null,
        }),
      },
    });
    return this.dto(id);
  }

  async cancel(
    actorId: string,
    id: string,
    input: CancelBookingInput,
  ): Promise<BookingDto> {
    await this.load(id);
    await this.cancellation.cancel(id, {
      actorId,
      reason: input.reason,
      refund: input.refund,
      notify: input.notifyCustomer,
      rejectWallet: input.rejectWalletPayment,
    });
    return this.dto(id);
  }

  /**
   * The bKash / Nagad money was paid back by hand: marks every refunded wallet payment of the booking still due as sent.
   * Conditional on "not yet sent", so a double click records it once (the second gets 409 NO_REFUND_DUE).
   */
  async markRefundSent(
    actorId: string,
    id: string,
    { note }: RefundSentInput,
  ): Promise<BookingDto> {
    await this.load(id);
    await this.prisma.$transaction(async (tx) => {
      const due = await tx.payment.findMany({
        where: { bookingId: id, ...REFUND_DUE },
        select: { id: true, amount: true, method: true },
      });
      const { count } = await tx.payment.updateMany({
        where: { id: { in: due.map((p) => p.id) }, ...REFUND_DUE },
        data: {
          refundSentAt: new Date(),
          refundSentById: actorId,
          refundNote: note || null,
        },
      });
      if (count === 0)
        throw new AppError(
          'No refund is due on this booking',
          409,
          'NO_REFUND_DUE',
        );
      const amount = due.reduce((sum, p) => sum + p.amount, 0);
      const methods = [...new Set(due.map((p) => methodName(p.method)))].join(
        ' and ',
      );
      await tx.bookingEvent.create({
        data: {
          bookingId: id,
          type: 'refunded',
          userId: actorId,
          detail: `Refund of ${amount} sent back by ${methods}${note ? `: ${note}` : ''}`,
        },
      });
    });
    return this.dto(id);
  }

  /**
   * The team didn't turn up. Payments stay as they are, so an advance is still revenue; the rest of
   * the due is written off (`dueOf` is 0 for no_show). The slot stays booked and no email is sent.
   */
  async markNoShow(
    actorId: string,
    id: string,
    { reason }: NoShowInput,
  ): Promise<BookingDto> {
    const booking = await this.load(id);
    assertCanMarkNoShow(booking, venueNow());
    const writtenOff = dueOf(booking, booking.payments);
    await this.prisma.$transaction(async (tx) => {
      // From the status it was read in: a cancel, payment or confirm that got in first wins (409, rolled back).
      const { count } = await tx.booking.updateMany({
        where: { id, status: booking.status },
        data: { status: 'no_show' },
      });
      if (count === 0) throw bookingChanged();
      await tx.bookingEvent.create({
        data: {
          bookingId: id,
          type: 'no_show',
          userId: actorId,
          detail: noShowDetail(writtenOff, reason),
        },
      });
    });
    return this.dto(id);
  }

  /** Back to completed (slot ended) or confirmed; the due comes back with the status. */
  async undoNoShow(actorId: string, id: string): Promise<BookingDto> {
    const booking = await this.load(id);
    if (booking.status !== 'no_show')
      throw new AppError(
        'This booking is not marked no-show',
        409,
        'NOT_NO_SHOW',
      );
    const status = undoneStatusOf(booking, venueNow());
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.booking.updateMany({
        where: { id, status: 'no_show' },
        data: { status, confirmedAt: booking.confirmedAt ?? new Date() },
      });
      if (count === 0) throw bookingChanged();
      await tx.bookingEvent.create({
        data: {
          bookingId: id,
          type: status,
          userId: actorId,
          detail: 'No-show undone',
        },
      });
    });
    return this.dto(id);
  }

  async resendConfirmation(id: string): Promise<{ sent: boolean }> {
    const booking = await this.load(id);
    if (booking.status !== 'confirmed' && booking.status !== 'completed') {
      throw new AppError(
        'Only confirmed bookings have a confirmation to send',
        409,
        'BOOKING_NOT_CONFIRMED',
      );
    }
    if (!booking.contactEmail)
      throw new AppError('This customer has no email address', 409, 'NO_EMAIL');
    return { sent: await this.notifier.confirmed(id) };
  }

  private async addPayment(
    tx: Prisma.TransactionClient,
    bookingId: string,
    actorId: string,
    p: StaffPayment,
  ) {
    const payment = await tx.payment.create({
      data: {
        bookingId,
        method: p.method,
        amount: p.amount,
        currency: env.CURRENCY,
        status: 'succeeded',
        receivedAt: new Date(),
        reference: p.reference ?? null,
        note: p.note ?? null,
        recordedById: actorId,
      },
    });
    await tx.bookingEvent.create({
      data: {
        bookingId,
        type: 'payment_received',
        userId: actorId,
        detail: receivedDetail(p.amount, p.method, p.reference),
      },
    });
    return payment;
  }

  private async load(id: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id, deletedAt: null },
      include: BOOKING_INCLUDE,
    });
    if (!booking) throw bookingNotFound();
    return booking;
  }

  private async dto(id: string): Promise<BookingDto> {
    return toBookingDto(
      await this.prisma.booking.findUniqueOrThrow({
        where: { id },
        include: BOOKING_INCLUDE,
      }),
    );
  }
}

/** The amount received now: all of it, the advance (less than the total), or nothing. */
function paymentAmount(
  payment: CreateStaffBookingInput['payment'],
  total: number,
): number {
  if (payment.type === 'none') return 0;
  if (payment.type === 'full') return total;
  if (payment.amount! >= total)
    throw exceedsDue(
      'An advance must be less than the total; record it as a full payment',
    );
  return payment.amount!;
}

function newStaffBooking(
  actorId: string,
  input: CreateStaffBookingInput,
  slots: Slot[],
  paid: number,
  bookingNumber: string,
) {
  const primary = slots[0]!;
  const total = sumPrice(slots);
  const { payment, customer } = input;
  const events: Prisma.BookingEventCreateWithoutBookingInput[] = [
    {
      type: 'created',
      detail: 'Booked by staff',
      user: { connect: { id: actorId } },
    },
  ];
  if (paid > 0) {
    events.push(
      {
        type: 'payment_received',
        detail: receivedDetail(paid, payment.method!, payment.reference),
        user: { connect: { id: actorId } },
      },
      {
        type: 'confirmed',
        detail: 'Confirmed on booking',
        user: { connect: { id: actorId } },
      },
    );
  }
  return {
    bookingNumber,
    source: 'staff' as const,
    groundId: primary.groundId,
    slotId: primary.id,
    liveSlotId: primary.id,
    contactName: customer.name,
    contactPhone: customer.phone,
    status: paid > 0 ? ('confirmed' as const) : ('pending' as const),
    paymentStatus:
      paid === 0
        ? ('unpaid' as const)
        : paid >= total
          ? ('paid' as const)
          : ('partial' as const),
    confirmedAt: paid > 0 ? new Date() : null,
    amount: total,
    serviceFee: 0,
    total,
    bookingSlots: {
      create: slots.map((s) => ({
        slotId: s.id,
        liveSlotId: s.id,
        price: s.price,
      })),
    },
    dueDate:
      payment.type === 'partial' && payment.dueDate
        ? toDbDate(payment.dueDate)
        : null,
    dueNote: payment.type === 'partial' ? (payment.note ?? null) : null,
    notes: input.notes ?? null,
    createdById: actorId,
    payments:
      paid > 0
        ? {
            create: [
              {
                method: payment.method!,
                amount: paid,
                currency: env.CURRENCY,
                status: 'succeeded' as const,
                receivedAt: new Date(),
                reference: payment.reference ?? null,
                note: payment.note ?? null,
                recordedById: actorId,
              },
            ],
          }
        : undefined,
    events: { create: events },
  };
}
