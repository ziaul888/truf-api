import type {
  PlatformBillingInterval,
  PlatformSubscriptionState,
} from '../generated/prisma/client.js';
import { venueNow, toDbDate } from '../slots/venue-time.js';
export const PLATFORM_BILLING_TIMEZONE = 'Asia/Dhaka';
export const billingToday = (now = new Date()) =>
  toDbDate(venueNow(now, PLATFORM_BILLING_TIMEZONE).date);
export const billingDate = (value: Date) => value.toISOString().slice(0, 10);
/** Calculate from the original anchor: January 31 -> February 28 -> March 31. */
export function billingPeriod(
  anchor: Date,
  interval: PlatformBillingInterval,
  index: number,
) {
  const shift = (period: number) => {
    const monthIndex =
      anchor.getUTCMonth() + period * (interval === 'monthly' ? 1 : 12);
    const year = anchor.getUTCFullYear() + Math.floor(monthIndex / 12),
      month = monthIndex % 12;
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(anchor.getUTCDate(), last)));
  };
  return { start: shift(index), end: shift(index + 1) };
}
export type EffectiveSubscriptionState =
  'pending' | 'scheduled' | 'active' | 'past_due' | 'cancelled';
export function subscriptionState(
  row: {
    status: PlatformSubscriptionState;
    anchorDate: Date;
    paidThrough: Date | null;
    cancelAtPeriodEnd: boolean;
  },
  today = billingToday(),
): EffectiveSubscriptionState {
  if (row.status === 'cancelled') return 'cancelled';
  if (!row.paidThrough) return 'pending';
  if (row.cancelAtPeriodEnd && row.paidThrough <= today) return 'cancelled';
  if (row.anchorDate > today) return 'scheduled';
  return row.paidThrough > today ? 'active' : 'past_due';
}
