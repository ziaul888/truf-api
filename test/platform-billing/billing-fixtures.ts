import { hashPassword } from '../../src/auth/password.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { credentials } from './billing-state.js';
export async function cleanupBilling(db: PrismaService) {
  const tenant = { slug: { startsWith: 'billing-e2e-' } };
  await db.platformAuditEvent.deleteMany({
    where: {
      OR: [{ tenant }, { actor: { email: { endsWith: '@billing-e2e.test' } } }],
    },
  });
  await db.platformReceipt.deleteMany({ where: { tenant } });
  await db.platformInvoice.deleteMany({ where: { tenant } });
  await db.platformSubscription.deleteMany({ where: { tenant } });
  await db.platformPlanVersion.deleteMany({
    where: { plan: { code: { startsWith: 'billing-e2e-' } } },
  });
  await db.platformPlan.deleteMany({
    where: { code: { startsWith: 'billing-e2e-' } },
  });
  await db.tenantMembership.deleteMany({ where: { tenant } });
  await db.tenant.deleteMany({ where: tenant });
  await db.platformGrant.deleteMany({
    where: { user: { email: { endsWith: '@billing-e2e.test' } } },
  });
  await db.user.deleteMany({
    where: { email: { endsWith: '@billing-e2e.test' } },
  });
}
export async function seedBilling(db: PrismaService) {
  await cleanupBilling(db);
  const passwordHash = await hashPassword(credentials.password);
  const admin = await db.user.create({
    data: {
      email: credentials.email,
      name: 'Billing Admin',
      role: 'manager',
      passwordHash,
    },
  });
  const staff = await db.user.create({
    data: {
      email: 'staff@billing-e2e.test',
      name: 'Existing Staff',
      role: 'admin',
      passwordHash,
    },
  });
  await db.platformGrant.create({ data: { userId: admin.id } });
  return { adminId: admin.id, staffId: staff.id };
}
