import { hashPassword } from '../../src/auth/password.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  platformLogin,
  staffLogin,
  type PlatformFixtures,
} from './platform-state.js';
export async function cleanPlatformFixtures(db: PrismaService) {
  await db.tenantMembership.deleteMany({
    where: { tenant: { slug: { startsWith: 'platform-e2e-' } } },
  });
  await db.tenant.deleteMany({
    where: { slug: { startsWith: 'platform-e2e-' } },
  });
  await db.platformGrant.deleteMany({
    where: { user: { email: { endsWith: '@platform-e2e.test' } } },
  });
  await db.user.deleteMany({
    where: { email: { endsWith: '@platform-e2e.test' } },
  });
}
export async function seedPlatformFixtures(
  db: PrismaService,
): Promise<PlatformFixtures> {
  await cleanPlatformFixtures(db);
  const passwordHash = await hashPassword(platformLogin.password);
  const user = await db.user.create({
    data: {
      email: platformLogin.email,
      name: 'Platform Admin',
      role: 'manager',
      passwordHash,
    },
  });
  const staff = await db.user.create({
    data: {
      email: staffLogin.email,
      name: 'Turf Owner',
      role: 'admin',
      passwordHash,
    },
  });
  await db.platformGrant.create({ data: { userId: user.id } });
  const a = await db.tenant.create({
    data: {
      name: 'Platform E2E Alpha',
      slug: 'platform-e2e-alpha',
      status: 'active',
      memberships: { create: { userId: staff.id, role: 'owner' } },
    },
  });
  const b = await db.tenant.create({
    data: {
      name: 'Platform E2E Beta',
      slug: 'platform-e2e-beta',
      status: 'suspended',
    },
  });
  const draft = await db.tenant.create({
    data: {
      name: 'Platform E2E Draft',
      slug: 'platform-e2e-draft',
      status: 'draft',
    },
  });
  return {
    userId: user.id,
    staffId: staff.id,
    aId: a.id,
    bId: b.id,
    draftId: draft.id,
  };
}
