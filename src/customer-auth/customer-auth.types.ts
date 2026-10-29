import type { Request } from 'express';
import type { Customer } from '../generated/prisma/client.js';

/** The signed-in customer. `name`/`email` are null until their first booking creates the record. */
export interface CustomerSession {
  phone: string;
  customerId: string | null;
  name: string | null;
  email: string | null;
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
  return { phone, customerId: live?.id ?? null, name: live?.name ?? null, email: live?.email ?? null };
};
