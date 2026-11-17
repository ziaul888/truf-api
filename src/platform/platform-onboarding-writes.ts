import { AppError } from '../common/app-error.js';
import type { PlatformTx } from './platform-command.js';
import type { CreateTurf } from './platform-onboarding.schemas.js';
async function availableOwner(
  tx: PlatformTx,
  input: CreateTurf,
  passwordHash: string,
) {
  const owner = await tx.user.upsert({
    where: { email: input.ownerEmail },
    update: {},
    create: {
      email: input.ownerEmail,
      name: input.ownerName,
      passwordHash,
      role: 'manager',
      isActive: false,
      legacyStaffAccess: false,
    },
    select: { id: true },
  });
  const assigned = await tx.tenantMembership.findFirst({
    where: { userId: owner.id, role: 'owner', isActive: true },
    select: { id: true },
  });
  if (assigned)
    throw new AppError(
      'This owner is already assigned to a turf',
      409,
      'OWNER_ALREADY_ASSIGNED',
    );
  return owner;
}
export async function createTurf(
  tx: PlatformTx,
  input: CreateTurf,
  passwordHash: string,
) {
  const existing = await tx.tenant.findUnique({
    where: { slug: input.slug },
    select: { id: true },
  });
  if (existing)
    throw new AppError(
      'This turf handle is already in use',
      409,
      'TENANT_SLUG_IN_USE',
    );
  const owner = await availableOwner(tx, input, passwordHash);
  const tenant = await tx.tenant.create({
    data: {
      name: input.name,
      slug: input.slug,
      timezone: input.timezone,
      currency: input.currency,
      status: 'draft',
      memberships: { create: { userId: owner.id, role: 'owner' } },
    },
  });
  return {
    targetId: tenant.id,
    tenantId: tenant.id,
    details: { ownerId: owner.id, status: 'draft' },
  };
}
