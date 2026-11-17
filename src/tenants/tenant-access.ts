import { AppError } from '../common/app-error.js';
import type {
  Prisma,
  TenantMembershipRole,
} from '../generated/prisma/client.js';

export const membershipAccessSelect = {
  tenantId: true,
  userId: true,
  role: true,
  isActive: true,
  tenant: { select: { status: true } },
  user: { select: { isActive: true } },
} satisfies Prisma.TenantMembershipSelect;

type MembershipAccess = Prisma.TenantMembershipGetPayload<{
  select: typeof membershipAccessSelect;
}>;
type MembershipQuery = {
  where: { tenantId_userId: { tenantId: string; userId: string } };
  select: typeof membershipAccessSelect;
};

/** Narrow interface shared by the real client and the isolated database proof. */
export interface MembershipReader {
  findUnique(args: MembershipQuery): Promise<MembershipAccess | null>;
}

export interface TenantContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: TenantMembershipRole;
}

export async function resolveTenantAccess(
  reader: MembershipReader,
  userId: string,
  tenantId: string,
  roles: readonly TenantMembershipRole[] = [],
): Promise<TenantContext> {
  const membership = await reader.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: membershipAccessSelect,
  });
  if (
    !membership?.isActive ||
    !membership.user.isActive ||
    membership.userId !== userId ||
    membership.tenantId !== tenantId
  ) {
    throw new AppError(
      'You do not have access to this business',
      403,
      'TENANT_ACCESS_DENIED',
    );
  }
  if (membership.tenant.status !== 'active') {
    throw new AppError(
      'This business is not active',
      403,
      'TENANT_UNAVAILABLE',
    );
  }
  if (roles.length && !roles.includes(membership.role)) {
    throw new AppError(
      'You do not have permission to do that',
      403,
      'TENANT_ROLE_REQUIRED',
    );
  }
  return Object.freeze({ tenantId, userId, role: membership.role });
}
