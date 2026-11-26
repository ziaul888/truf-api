import { AppError } from '../common/app-error.js';
import type { Request } from 'express';
import type { Customer } from '../generated/prisma/client.js';

/**
 * The signed-in customer. A number with no customer record yet has null `customerId`, `name` and
 * `email`, and `needsProfile: true`: ask for name and email (POST /customer/auth/profile).
 */
export interface CustomerSession {
  phone: string | null;
  customerId: string | null;
  name: string | null;
  email: string | null;
  needsProfile: boolean;
  verifiedEmail?: string;
  signInMethod?: 'email';
}

export type CustomerJwtPayload = {
  /** Verified phone for existing SMS sessions, customer ID for email sessions. */
  sub: string;
  ver: number;
  tenantId?: string;
} & ({ method?: 'phone' } | { method: 'email'; emailVersion: number });

export type CustomerRequest = Request & { customer?: CustomerSession };

export const toCustomerSession = (
  phone: string | null,
  c: Customer | null,
  signedInWithEmail = false,
): CustomerSession => {
  const live = c && !c.deletedAt ? c : null;
  return {
    phone,
    customerId: live?.id ?? null,
    name: live?.name || null,
    email: live?.email ?? null,
    needsProfile: !live?.name,
    ...(live?.verifiedEmail && { verifiedEmail: live.verifiedEmail }),
    ...(signedInWithEmail && { signInMethod: 'email' as const }),
  };
};

/** Guests and customers with a verified phone can continue through the existing checkout flow. */
export function checkoutPhone(
  session: CustomerSession | null,
): string | undefined {
  if (session && !session.phone) {
    throw new AppError(
      'Verify your phone number to book a slot.',
      403,
      'PHONE_VERIFICATION_REQUIRED',
    );
  }
  return session?.phone ?? undefined;
}
