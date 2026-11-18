import { BadRequestException } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import type { SlotSettings } from '../slots/slots.schemas.js';
import { methodName } from './booking-rules.js';
import type { CheckoutInput } from './bookings.schemas.js';
import { cashDepositPercentOf, portalWalletNumber } from './portal-methods.js';

const DEPOSIT_FIELDS = ['depositMethod', 'reference', 'payerNumber'] as const;

/**
 * A cash checkout and its deposit (`cashDepositEnabled`, wallet offered): the customer must also send
 * the deposit to the venue's bKash / Nagad number and give `depositMethod`, `reference` (TrxID) and
 * `payerNumber`. With the deposit off those fields are refused, as they always were for cash. The schema
 * can't tell (it is static), so the service calls this with the settings read for the request.
 * Returns the deposit percent when a deposit is due, else null.
 */
export function assertCashDepositInput(
  input: CheckoutInput,
  settings: SlotSettings,
): number | null {
  if (input.paymentMethod !== 'cash') return null;
  const percent = cashDepositPercentOf(settings);
  if (percent === null) {
    const details = DEPOSIT_FIELDS.filter(
      (field) => input[field] !== undefined,
    ).map((field) => ({ field, message: 'Only for bKash and Nagad' }));
    if (details.length > 0)
      throw new BadRequestException({
        message: 'Some fields are invalid',
        code: 'VALIDATION_FAILED',
        details,
      });
    return null;
  }
  if (
    input.depositMethod === undefined ||
    input.reference === undefined ||
    input.payerNumber === undefined
  ) {
    throw new AppError(
      `Paying cash at the venue needs a ${percent}% deposit by bKash or Nagad: send depositMethod, reference (TrxID) and payerNumber`,
      400,
      'CASH_DEPOSIT_REQUIRED',
    );
  }
  if (!portalWalletNumber(settings, input.depositMethod)) {
    throw new AppError(
      `${methodName(input.depositMethod)} payment is not available right now`,
      400,
      'WALLET_NOT_AVAILABLE',
    );
  }
  return percent;
}
