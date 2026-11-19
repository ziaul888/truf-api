import { AppError } from '../common/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import type {
  OwnerContext,
  OwnerSession,
  TenantOperator,
} from './owner-session.js';
import { configuredVenue } from './owner-venue.js';
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
      setup: { select: { data: true } },
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
  const context = tenantOperator(row, session);
  if (context.user.role !== 'owner') throw ownerUnauthenticated();
  return { session: context.session, user: context.user };
}

export function tenantOperator(
  row: OwnerMembership,
  session: OwnerSession,
): TenantOperator {
  if (
    !row.isActive ||
    (row.role !== 'owner') !== Boolean(session.staff) ||
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
  const identity = {
    id: row.user.id,
    email: row.user.email,
    name: row.user.name,
    tenant: {
      id,
      slug,
      name,
      status,
      timezone,
      currency,
      setupComplete: Boolean(configuredVenue(row.tenant.setup?.data)),
    },
  };
  return {
    session: Object.freeze({ ...session }),
    user:
      row.role === 'owner'
        ? { ...identity, role: 'owner', audience: 'owner' }
        : { ...identity, role: row.role, audience: 'tenant-staff' },
  };
}
export async function requireOwner(
  tx: Prisma.TransactionClient,
  session: OwnerSession,
) {
  return ownerContext(await findMembership(tx, session), session);
}

export async function requireTenantOperator(
  tx: Prisma.TransactionClient,
  session: OwnerSession,
) {
  return tenantOperator(await findMembership(tx, session), session);
}

async function findMembership(
  tx: Prisma.TransactionClient,
  session: OwnerSession,
) {
  const row = await tx.tenantMembership.findUnique({
    where: { id: session.mid },
    select: ownerMembershipSelect,
  });
  if (!row) throw ownerUnauthenticated();
  return row;
}
