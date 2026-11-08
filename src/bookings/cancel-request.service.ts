import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SlotSettingsService } from '../slots/slot-settings.service.js';
import { fromDbDate, minutesUntil, venueNow } from '../slots/venue-time.js';
import { BookingNotifier } from './booking-notifier.service.js';
import { bookingNotFound, isUnderReview, isValidBookingToken, methodName, pendingWalletPayment } from './booking-rules.js';
import { BOOKING_INCLUDE } from './booking.dto.js';

const alreadyRequested = () => new AppError('You have already asked to cancel this booking', 409, 'CANCEL_ALREADY_REQUESTED');
const notUnderReview = () =>
  new AppError('This booking has no payment being verified. Cancel it from this page instead', 409, 'NOT_UNDER_REVIEW');

/**
 * While the venue verifies a bKash / Nagad payment the customer can't cancel directly (the money
 * isn't confirmed yet). They ask instead, once, before the cancellation cutoff; staff then verify
 * and cancel with a refund, or reject the payment.
 */
@Injectable()
export class CancelRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SlotSettingsService,
    private readonly notifier: BookingNotifier,
  ) {}

  async request(id: string, token: string | undefined): Promise<void> {
    if (!isValidBookingToken(id, token)) throw bookingNotFound();
    const b = await this.prisma.booking.findFirst({ where: { id, deletedAt: null }, include: BOOKING_INCLUDE });
    if (!b) throw bookingNotFound();
    const { cancellationCutoffHours } = await this.settings.get();
    if (b.source !== 'portal' || minutesUntil(venueNow(), fromDbDate(b.slot.date), b.slot.startHour) <= cancellationCutoffHours * 60) {
      throw new AppError(
        `Bookings can't be cancelled online within ${cancellationCutoffHours} hours of the start. Please contact the venue`,
        400, 'CANCELLATION_WINDOW_PASSED',
      );
    }
    if (b.cancelRequestedAt) throw alreadyRequested();
    const wallet = pendingWalletPayment(b.payments);
    if (!wallet || !isUnderReview(b, b.payments)) throw notUnderReview();
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.booking.updateMany({ where: { id, status: 'pending', cancelRequestedAt: null }, data: { cancelRequestedAt: new Date() } });
      if (count === 0) {
        // Lost a race: another request got in, or staff verified / rejected it meanwhile.
        const now = await tx.booking.findUnique({ where: { id }, select: { cancelRequestedAt: true } });
        throw now?.cancelRequestedAt ? alreadyRequested() : notUnderReview();
      }
      await tx.bookingEvent.create({
        data: {
          bookingId: id, type: 'cancel_requested',
          detail: `The customer asked to cancel while their ${methodName(wallet.method)} payment (TrxID ${wallet.reference ?? 'none'}) is being verified`,
        },
      });
    });
    await this.notifier.cancelRequestToStaff(id);
  }
}
