import { cardPaymentsEnabled } from '../payments/stripe.service.js';
import type { SlotSettings } from '../slots/slots.schemas.js';
import { WALLET_METHODS, type WalletMethod } from './booking-rules.js';

/**
 * Which ways to pay the portal offers. Each needs the admin's switch on (Settings → Payments) plus
 * what it can't work without: card the Stripe keys, bKash / Nagad the venue's number. Cash has
 * its own switch only (`portalCashEnabled`).
 */
export const portalCardOn = (
  settings: Pick<SlotSettings, 'portalCardEnabled'>,
) => cardPaymentsEnabled() && settings.portalCardEnabled;

/** The number customers send money to, or null while that wallet isn't offered. */
export function portalWalletNumber(
  settings: SlotSettings,
  method: WalletMethod,
): string | null {
  const [on, number] =
    method === 'bkash'
      ? [settings.portalBkashEnabled, settings.bkashNumber]
      : [settings.portalNagadEnabled, settings.nagadNumber];
  return on ? number : null;
}

/** The wallets the portal offers right now: only those with a number and switched on. */
export const portalWallets = (settings: SlotSettings) =>
  WALLET_METHODS.flatMap((method) => {
    const number = portalWalletNumber(settings, method);
    return number ? [{ method, number }] : [];
  });

/**
 * The deposit percent a cash checkout must also pay by bKash / Nagad, or null when there is none:
 * the admin's switch is off, or no wallet is offered to send it to.
 */
export const cashDepositPercentOf = (settings: SlotSettings): number | null =>
  settings.cashDepositEnabled && portalWallets(settings).length > 0
    ? settings.cashDepositPercent
    : null;

/** Cash is offered unless its own switch is off, or a deposit is wanted but there is no wallet to take it. */
export const portalCashOn = (settings: SlotSettings) =>
  settings.portalCashEnabled &&
  (!settings.cashDepositEnabled || portalWallets(settings).length > 0);

/** What a cash checkout pays now by wallet: a percent of the total, never above it (smallest unit). */
export const depositOf = (total: number, percent: number) =>
  Math.min(total, Math.round((total * percent) / 100));
