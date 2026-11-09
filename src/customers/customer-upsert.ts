import type { Prisma } from '../generated/prisma/client.js';

export interface CustomerContact {
  name: string;
  /** Normalised. */
  phone: string;
  /** Null or absent: none given. */
  email?: string | null;
}

/**
 * Finds the customer by phone (restoring one that was deleted) or creates them.
 * `overwrite` updates name and email: staff are trusted to, a portal checkout is not
 * (the booking keeps its own contact details instead). No email given never clears a stored one.
 */
export async function upsertCustomerByPhone(
  db: Prisma.TransactionClient, contact: CustomerContact, overwrite: boolean,
): Promise<string> {
  const email = contact.email ?? null;
  const existing = await db.customer.findUnique({ where: { phone: contact.phone } });
  if (!existing) return (await db.customer.create({ data: { name: contact.name, phone: contact.phone, email } })).id;
  if (overwrite || existing.deletedAt) {
    await db.customer.update({
      where: { id: existing.id },
      data: { ...(overwrite && { name: contact.name, ...(email !== null && { email }) }), deletedAt: null },
    });
  }
  return existing.id;
}

/** The email for a booking's contact: the one given, else the customer's stored one, else none. */
export async function contactEmailOf(
  db: Prisma.TransactionClient, customerId: string, given: string | null | undefined,
): Promise<string | null> {
  if (given) return given;
  const stored = await db.customer.findUnique({ where: { id: customerId }, select: { email: true } });
  return stored?.email ?? null;
}
