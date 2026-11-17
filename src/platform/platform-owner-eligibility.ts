import { AppError } from '../common/app-error.js';
import type { PlatformTx } from './platform-command.js';
import {
  ownerMembershipSelect,
  type OwnerMembership,
} from '../owner/owner-access.js';
export async function turfOwner(tx: PlatformTx, tenantId: string) {
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true },
  });
  if (!tenant)
    throw new AppError(
      'Turf business not found',
      404,
      'PLATFORM_TENANT_NOT_FOUND',
    );
  const owners = await tx.tenantMembership.findMany({
    where: { tenantId, role: 'owner', isActive: true },
    select: ownerMembershipSelect,
    take: 2,
  });
  return owners.length === 1 ? owners[0]! : null;
}
export async function canInviteOwner(tx: PlatformTx, row: OwnerMembership) {
  if (
    row.user.isActive ||
    row.user.legacyStaffAccess ||
    !['draft', 'active'].includes(row.tenant.status)
  )
    return false;
  if (
    (await tx.tenantMembership.count({ where: { userId: row.userId } })) !== 1
  )
    return false;
  if (
    await tx.ownerInvitation.count({
      where: { membershipId: row.id, consumedAt: { not: null } },
    })
  )
    return false;
  return true;
}
