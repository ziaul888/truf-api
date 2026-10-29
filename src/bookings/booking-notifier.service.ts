import { Injectable } from '@nestjs/common';
import { env } from '../config/env.js';
import { EmailService, type EmailMessage } from '../email/email.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SlotSettingsService } from '../slots/slot-settings.service.js';
import { fromDbDate } from '../slots/venue-time.js';
import { confirmationUrl } from './booking-rules.js';
import { BOOKING_INCLUDE, type BookingRow } from './booking.dto.js';

const money = (amount: number) => `${(amount / 100).toFixed(2)} ${env.CURRENCY.toUpperCase()}`;
const hour = (h: number) => `${String(h).padStart(2, '0')}:00`;
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
 * booking's own signed link.
 */
@Injectable()
export class BookingNotifier {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly settings: SlotSettingsService,
  ) {}

  async confirmed(bookingId: string): Promise<boolean> {
    const b = await this.load(bookingId);
    return this.sendTo(b, b.contactEmail, `Booking ${b.bookingNumber} confirmed`, [
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
    return this.sendTo(b, b.contactEmail, `Booking ${b.bookingNumber} received`, [
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
    return this.sendTo(b, b.contactEmail, `Booking ${b.bookingNumber} cancelled`, lines);
  }

  /** An online payment that arrived when nothing was owed, refunded in full. */
  async paymentRefunded(bookingId: string, amount: number): Promise<boolean> {
    const b = await this.load(bookingId);
    return this.sendTo(b, b.contactEmail, `Payment refunded for booking ${b.bookingNumber}`, [
      `Hi ${b.contactName},`,
      `We received ${money(amount)} for booking ${b.bookingNumber}, but nothing was due on it any more, so we've refunded it in full.`,
      `It usually arrives within 5–10 working days. Your booking: ${confirmationUrl(b.id)}`,
    ]);
  }

  /** "New booking" to every active admin, if the notifyAdminOnBooking setting is on. */
  async newBookingToAdmins(bookingId: string): Promise<void> {
    if (!(await this.settings.get()).notifyAdminOnBooking) return;
    const b = await this.load(bookingId);
    const admins = await this.prisma.user.findMany({ where: { role: 'admin', isActive: true }, select: { email: true } });
    for (const { email } of admins) {
      await this.sendTo(b, email, `New booking ${b.bookingNumber}`, [
        `${b.contactName} booked ${b.ground.name} for ${when(b)}.`,
        `Total: ${money(b.total)} (${b.paymentStatus})`,
        `Dashboard: ${env.PUBLIC_APP_URL}/dashboard/bookings/${b.id}`,
      ]);
    }
  }

  async paymentDue(bookingId: string, due: number): Promise<boolean> {
    const b = await this.load(bookingId);
    return this.sendTo(b, b.contactEmail, `Payment due for booking ${b.bookingNumber}`, [
      `Hi ${b.contactName},`,
      `A reminder that ${money(due)} is due for your booking at ${b.ground.name} (${when(b)}).`,
      ...(b.dueNote ? [b.dueNote] : []),
    ]);
  }

  private async sendTo(b: BookingRow, to: string, subject: string, lines: string[]): Promise<boolean> {
    const message: EmailMessage = { to, subject, text: lines.join('\n\n') };
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
