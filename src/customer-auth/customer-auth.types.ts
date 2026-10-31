import type { Request } from 'express';
import type { Customer } from '../generated/prisma/client.js';

/**
 * The signed-in customer. A number with no customer record yet has null `customerId`, `name` and
 * `email`, and `needsProfile: true`: ask for name and email (POST /customer/auth/profile).
 */
export interface CustomerSession {
  phone: string;
  customerId: string | null;
  name: string | null;
  email: string | null;
  needsProfile: boolean;
}

export interface CustomerJwtPayload {
  /** The verified phone number. */
  sub: string;
  /** The customer's `sessionVersion` when the token was issued; a mismatch means signed out. */
  ver: number;
}

export type CustomerRequest = Request & { customer?: CustomerSession };

export const toCustomerSession = (phone: string, c: Customer | null): CustomerSession => {
  const live = c && !c.deletedAt ? c : null;
  return { phone, customerId: live?.id ?? null, name: live?.name ?? null, email: live?.email ?? null, needsProfile: !live };
};
