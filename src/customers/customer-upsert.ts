import type { Prisma } from '../generated/prisma/client.js';

export interface CustomerContact {
  name: string;
  /** Normalised. */
  phone: string;
  email: string;
}

/**
 * Finds the customer by phone (restoring one that was deleted) or creates them.
 * `overwrite` updates name and email: staff are trusted to, a portal checkout is not
 * (the booking keeps its own contact details instead).
 */
export async function upsertCustomerByPhone(
  db: Prisma.TransactionClient, contact: CustomerContact, overwrite: boolean,
): Promise<string> {
  const existing = await db.customer.findUnique({ where: { phone: contact.phone } });
  if (!existing) return (await db.customer.create({ data: contact })).id;
  if (overwrite || existing.deletedAt) {
    await db.customer.update({
      where: { id: existing.id },
      data: { ...(overwrite && { name: contact.name, email: contact.email }), deletedAt: null },
    });
  }
  return existing.id;
}
