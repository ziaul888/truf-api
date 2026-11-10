import { cardPaymentsEnabled } from '../payments/stripe.service.js';
import type { SlotSettings } from '../slots/slots.schemas.js';
import type { WalletMethod } from './booking-rules.js';

/**
 * Which ways to pay the portal offers. Each needs the admin's switch on (Settings → Payments) plus
 * what it can't work without: card the Stripe keys, bKash / Nagad the venue's number. Cash has
 * its own switch only (`portalCashEnabled`).
 */
export const portalCardOn = (settings: Pick<SlotSettings, 'portalCardEnabled'>) => cardPaymentsEnabled() && settings.portalCardEnabled;

/** The number customers send money to, or null while that wallet isn't offered. */
export function portalWalletNumber(settings: SlotSettings, method: WalletMethod): string | null {
  const [on, number] = method === 'bkash'
    ? [settings.portalBkashEnabled, settings.bkashNumber]
    : [settings.portalNagadEnabled, settings.nagadNumber];
  return on ? number : null;
}
