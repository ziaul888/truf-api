import { Injectable } from '@nestjs/common';
import { env } from '../config/env.js';
import { EmailService, type EmailMessage } from '../email/email.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsStore } from '../settings/settings-store.service.js';
import { SlotSettingsService } from '../slots/slot-settings.service.js';
import { fromDbDate } from '../slots/venue-time.js';
import { confirmationUrl } from './booking-rules.js';
import { BOOKING_INCLUDE, type BookingRow } from './booking.dto.js';

const money = (amount: number) => `${(amount / 100).toFixed(2)} ${env.CURRENCY.toUpperCase()}`;
const hour = (h: number) => `${String(h).padStart(2, '0')}:00`;
const section = (title: string, lines: string[]) => (lines.length > 0 ? [`${title}:\n${lines.join('\n')}`] : []);
const when = (b: BookingRow) =>
  `${fromDbDate(b.slot.date)}, ${hour(b.slot.startHour)}–${hour(b.slot.startHour + b.slot.durationMinutes / 60)}`;

export interface CancelledNotice {
  reason?: string | null;
  refunded: number;
  /** The slot was blocked by staff (closure, maintenance…). */
  becauseBlocked?: boolean;
}

/**
 * Booking emails. Each one sent is logged as an `email_sent` booking event. Sending never throws,
 * so an email problem can't fail a booking. Never include card data or tokens other than the
 * booking's own signed link. Confirmation and cancellation emails always send (they carry the
 * link); the rest follow the Notifications settings.
 */
@Injectable()
export class BookingNotifier {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly settings: SlotSettingsService,
    private readonly store: SettingsStore,
  ) {}

  async confirmed(bookingId: string): Promise<boolean> {
    const b = await this.load(bookingId);
    return this.sendTo(b, 'booking_confirmed', b.contactEmail, `Booking ${b.bookingNumber} confirmed`, [
      `Hi ${b.contactName},`,
      `Your booking at ${b.ground.name} is confirmed.`,
      `Booking number: ${b.bookingNumber}`,
      `When: ${when(b)}`,
      `Total: ${money(b.total)}`,
      ...(b.ground.address ? [`Address: ${b.ground.address}`] : []),
      `View or cancel your booking: ${confirmationUrl(b.id)}`,
    ]);
  }

  /** A "pay at the venue" request: reserved, waiting for staff to confirm. */
  async received(bookingId: string): Promise<boolean> {
    const b = await this.load(bookingId);
    return this.sendTo(b, 'booking_received', b.contactEmail, `Booking ${b.bookingNumber} received`, [
      `Hi ${b.contactName},`,
      `We've reserved ${b.ground.name} for you and will confirm your booking shortly.`,
      `Booking number: ${b.bookingNumber}`,
      `When: ${when(b)}`,
      `Please pay ${money(b.total)} in cash at the venue.`,
      ...(b.ground.address ? [`Address: ${b.ground.address}`] : []),
      `View or cancel your booking: ${confirmationUrl(b.id)}`,
    ]);
  }

  async cancelled(bookingId: string, notice: CancelledNotice): Promise<boolean> {
    const b = await this.load(bookingId);
    const lines = [
      `Hi ${b.contactName},`,
      notice.becauseBlocked
        ? `We're sorry: ${b.ground.name} is unavailable at ${when(b)}, so we had to cancel booking ${b.bookingNumber}.`
        : `Booking ${b.bookingNumber} at ${b.ground.name} (${when(b)}) has been cancelled.`,
      ...(notice.reason ? [`Reason: ${notice.reason}`] : []),
      ...(notice.refunded > 0 ? [`A full refund of ${money(notice.refunded)} is on its way to your original payment method. It usually arrives within 5–10 working days.`] : []),
      ...(notice.becauseBlocked ? [`Book another time: ${env.PUBLIC_APP_URL}/grounds/${b.ground.id}`] : []),
    ];
    return this.sendTo(b, 'booking_cancelled', b.contactEmail, `Booking ${b.bookingNumber} cancelled`, lines);
  }

  /** An online payment that arrived when nothing was owed, refunded in full. */
  async paymentRefunded(bookingId: string, amount: number): Promise<boolean> {
    if (!(await this.store.get('notifications')).refundIssued) return false;
    const b = await this.load(bookingId);
    return this.sendTo(b, 'refund_issued', b.contactEmail, `Payment refunded for booking ${b.bookingNumber}`, [
      `Hi ${b.contactName},`,
      `We received ${money(amount)} for booking ${b.bookingNumber}, but nothing was due on it any more, so we've refunded it in full.`,
      `It usually arrives within 5–10 working days. Your booking: ${confirmationUrl(b.id)}`,
    ]);
  }

  /** "New booking" to the staff recipients, if the notifyAdminOnBooking setting is on. */
  async newBookingToAdmins(bookingId: string): Promise<void> {
    if (!(await this.settings.get()).notifyAdminOnBooking) return;
    const b = await this.load(bookingId);
    for (const email of await this.staffRecipients()) {
      await this.sendTo(b, 'staff_new_booking', email, `New booking ${b.bookingNumber}`, [
        `${b.contactName} booked ${b.ground.name} for ${when(b)}.`,
        `Total: ${money(b.total)} (${b.paymentStatus})`,
        `Dashboard: ${env.PUBLIC_APP_URL}/dashboard/bookings/${b.id}`,
      ]);
    }
  }

  /** Tells staff a customer cancelled through their link, if that setting is on. */
  async customerCancelledToStaff(bookingId: string): Promise<void> {
    if (!(await this.store.get('notifications')).customerCancelled) return;
    const b = await this.load(bookingId);
    for (const email of await this.staffRecipients()) {
      await this.sendTo(b, 'staff_customer_cancelled', email, `Booking ${b.bookingNumber} cancelled by the customer`, [
        `${b.contactName} (${b.contactPhone}) cancelled ${b.ground.name}, ${when(b)}. The slot is free again.`,
        `Dashboard: ${env.PUBLIC_APP_URL}/dashboard/bookings/${b.id}`,
      ]);
    }
  }

  /** The morning list of overdue and due-today money, to staff. Not sent when the list is empty. */
  async dueDigest(items: { bookingNumber: string; customerName: string; due: number; overdue: boolean }[]): Promise<number> {
    if (items.length === 0 || !(await this.store.get('notifications')).dueDigest) return 0;
    const line = (i: (typeof items)[number]) => `${i.bookingNumber} · ${i.customerName} · ${money(i.due)}`;
    const text = [
      ...section('Overdue', items.filter((i) => i.overdue).map(line)),
      ...section('Due today', items.filter((i) => !i.overdue).map(line)),
      `Dashboard: ${env.PUBLIC_APP_URL}/dashboard/bookings`,
    ].join('\n\n');
    let sent = 0;
    for (const to of await this.staffRecipients()) {
      if (await this.email.send({ to, subject: `Payments due: ${items.length}`, text, kind: 'staff_due_digest' })) sent += 1;
    }
    return sent;
  }

  async paymentDue(bookingId: string, due: number): Promise<boolean> {
    const b = await this.load(bookingId);
    return this.sendTo(b, 'payment_due', b.contactEmail, `Payment due for booking ${b.bookingNumber}`, [
      `Hi ${b.contactName},`,
      `A reminder that ${money(due)} is due for your booking at ${b.ground.name} (${when(b)}).`,
      ...(b.dueNote ? [b.dueNote] : []),
    ]);
  }

  /** The Notifications page's recipients, or every active admin when it lists none. */
  private async staffRecipients(): Promise<string[]> {
    const { staffRecipients } = await this.store.get('notifications');
    if (staffRecipients.length > 0) return staffRecipients;
    const admins = await this.prisma.user.findMany({ where: { role: 'admin', isActive: true }, select: { email: true } });
    return admins.map((a) => a.email);
  }

  private async sendTo(b: BookingRow, kind: string, to: string, subject: string, lines: string[]): Promise<boolean> {
    const message: EmailMessage = { to, subject, text: lines.join('\n\n'), kind, bookingId: b.id };
    const sent = await this.email.send(message);
    if (sent) {
      await this.prisma.bookingEvent.create({ data: { bookingId: b.id, type: 'email_sent', detail: subject } });
    }
    return sent;
  }

  private load(bookingId: string): Promise<BookingRow> {
    return this.prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: BOOKING_INCLUDE });
  }
}
