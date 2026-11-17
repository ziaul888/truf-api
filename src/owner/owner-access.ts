import { AppError } from '../common/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { OwnerContext, OwnerSession } from './owner-session.js';
export const ownerMembershipSelect = {
  id: true,
  userId: true,
  tenantId: true,
  role: true,
  isActive: true,
  tokenVersion: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      legacyStaffAccess: true,
      tokenVersion: true,
      createdAt: true,
    },
  },
  tenant: {
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      timezone: true,
      currency: true,
      createdAt: true,
    },
  },
} satisfies Prisma.TenantMembershipSelect;
export type OwnerMembership = Prisma.TenantMembershipGetPayload<{
  select: typeof ownerMembershipSelect;
}>;
export const ownerUnauthenticated = () =>
  new AppError(
    'Please sign in to your turf account',
    401,
    'OWNER_UNAUTHENTICATED',
  );
export function ownerContext(
  row: OwnerMembership,
  session: OwnerSession,
): OwnerContext {
  if (
    !row.isActive ||
    row.role !== 'owner' ||
    !row.user.isActive ||
    row.user.legacyStaffAccess ||
    row.tenant.status === 'archived' ||
    row.userId !== session.sub ||
    row.tenantId !== session.tid ||
    row.id !== session.mid ||
    row.user.tokenVersion !== session.uv ||
    row.tokenVersion !== session.mv
  )
    throw ownerUnauthenticated();
  const { id, slug, name, status, timezone, currency } = row.tenant;
  return {
    session: Object.freeze({ ...session }),
    user: {
      id: row.user.id,
      email: row.user.email,
      name: row.user.name,
      role: 'owner',
      audience: 'owner',
      tenant: { id, slug, name, status, timezone, currency },
    },
  };
}
export async function requireOwner(
  tx: Prisma.TransactionClient,
  session: OwnerSession,
) {
  const row = await tx.tenantMembership.findUnique({
    where: { id: session.mid },
    select: ownerMembershipSelect,
  });
  if (!row) throw ownerUnauthenticated();
  return ownerContext(row, session);
}
