import { AppError } from '../common/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { upcomingWhere } from '../slots/slot-rules.js';
import { venueNow } from '../slots/venue-time.js';
import { WALLET_UNDER_REVIEW } from './booking-rules.js';
import type { CheckoutInput } from './bookings.schemas.js';

/** Open unpaid portal bookings (cash, or bKash / Nagad under review) one phone may hold at once. */
export const MAX_OPEN_UNPAID = 3;

export const signInRequired = () =>
  new AppError('Sign in with your phone number to pay at the venue or by bKash / Nagad', 401, 'SIGN_IN_REQUIRED');
export const tooManyOpenBookings = () =>
  new AppError(
    `You already have ${MAX_OPEN_UNPAID} unpaid bookings waiting. Pay or cancel one of them first, or pay by card`,
    409, 'TOO_MANY_OPEN_BOOKINGS',
  );

/** Pending portal bookings on `phone` that hold a slot without money taken: cash, or a wallet payment under review. */
const openUnpaidWhere = (phone: string): Prisma.BookingWhereInput => ({
  deletedAt: null, status: 'pending', source: 'portal', contactPhone: phone, slot: upcomingWhere(venueNow()),
  OR: [{ payAtVenue: true }, WALLET_UNDER_REVIEW],
});

/**
 * Cash, bKash and Nagad book the slot with no money taken, so they need a verified phone
 * (customer sign-in) and at most `MAX_OPEN_UNPAID` open at once. Card checkouts are left alone:
 * their hold lapses on its own. Call before reserving anything.
 * The count is not locked: two requests at the same moment may both pass and make a 4th. Accepted.
 */
export async function assertCanBookUnpaid(
  prisma: PrismaService, method: CheckoutInput['paymentMethod'], verifiedPhone: string | undefined,
): Promise<void> {
  if (method === 'card') return;
  if (!verifiedPhone) throw signInRequired();
  const open = await prisma.booking.count({ where: openUnpaidWhere(verifiedPhone) });
  if (open >= MAX_OPEN_UNPAID) throw tooManyOpenBookings();
}
