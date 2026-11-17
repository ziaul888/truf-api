import { hashPassword } from '../../src/auth/password.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { platformCredentials } from './state.js';
export async function cleanupOwnerFixtures(db: PrismaService) {
  const tenant = { slug: { startsWith: 'owner-activation-e2e-' } },
    user = { email: { endsWith: '@owner-activation-e2e.test' } },
    plan = { code: { startsWith: 'owner-activation-e2e-' } };
  await db.ownerInvitation.deleteMany({ where: { membership: { tenant } } });
  await db.platformAuditEvent.deleteMany({
    where: { OR: [{ tenant }, { actor: user }] },
  });
  await db.platformReceipt.deleteMany({ where: { tenant } });
  await db.platformInvoice.deleteMany({ where: { tenant } });
  await db.platformSubscription.deleteMany({ where: { tenant } });
  await db.platformPlanVersion.deleteMany({ where: { plan } });
  await db.platformPlan.deleteMany({ where: plan });
  await db.tenantMembership.deleteMany({ where: { tenant } });
  await db.tenant.deleteMany({ where: tenant });
  await db.platformGrant.deleteMany({ where: { user } });
  await db.user.deleteMany({ where: user });
}
export async function seedOwnerFixtures(db: PrismaService) {
  await cleanupOwnerFixtures(db);
  const passwordHash = await hashPassword(platformCredentials.password);
  const admin = await db.user.create({
    data: {
      email: platformCredentials.email,
      name: 'Activation Platform Admin',
      passwordHash,
      role: 'admin',
    },
  });
  const staff = await db.user.create({
    data: {
      email: 'staff@owner-activation-e2e.test',
      name: 'Existing Staff',
      passwordHash,
      role: 'admin',
    },
  });
  await db.platformGrant.create({ data: { userId: admin.id } });
  return { adminId: admin.id, staffId: staff.id };
}
