import type { Prisma } from '../generated/prisma/client.js';

export const platformTenantSelect = {
  id: true,
  name: true,
  slug: true,
  status: true,
  currency: true,
  timezone: true,
  createdAt: true,
  updatedAt: true,
  memberships: {
    where: { isActive: true, role: 'owner' },
    select: {
      user: { select: { id: true, name: true, email: true, isActive: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: 1,
  },
  _count: {
    select: {
      memberships: { where: { isActive: true, user: { isActive: true } } },
    },
  },
} satisfies Prisma.TenantSelect;

type TenantRow = Prisma.TenantGetPayload<{
  select: typeof platformTenantSelect;
}>;
export const toPlatformTenantDto = (row: TenantRow) => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  status: row.status,
  currency: row.currency,
  timezone: row.timezone,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  owner: row.memberships[0]?.user ?? null,
  activeStaffCount: row._count.memberships,
});
