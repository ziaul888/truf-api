import type { Prisma } from '../generated/prisma/client.js';

export const tenantAccountSelect = {
  role: true,
  createdAt: true,
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

type AccountRow = Prisma.TenantMembershipGetPayload<{
  select: typeof tenantAccountSelect;
}>;

export const toTenantAccountDto = (row: AccountRow) => ({
  id: row.tenant.id,
  slug: row.tenant.slug,
  name: row.tenant.name,
  status: row.tenant.status,
  timezone: row.tenant.timezone,
  currency: row.tenant.currency,
  createdAt: row.tenant.createdAt.toISOString(),
  role: row.role,
  joinedAt: row.createdAt.toISOString(),
});
export type TenantAccountDto = ReturnType<typeof toTenantAccountDto>;
