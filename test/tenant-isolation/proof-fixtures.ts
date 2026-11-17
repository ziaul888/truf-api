import { hashPassword } from '../../src/auth/password.js';
import type { ProofDatabase } from './proof-database.js';

export const password = 'tenant-proof-password';
export interface ProofBusiness {
  tenantId: string;
  userId: string;
  email: string;
  groundId: string;
}
export interface ProofFixtures {
  a: ProofBusiness;
  b: ProofBusiness;
  manager: { userId: string; email: string };
  outsider: { userId: string; email: string };
}

export async function seedProof(db: ProofDatabase): Promise<ProofFixtures> {
  const passwordHash = await hashPassword(password);
  const makeUser = (name: string) =>
    db.admin.user.create({
      data: {
        name,
        email: `${name}@tenant-proof.test`,
        passwordHash,
        role: 'admin',
      },
    });
  const aUser = await makeUser('owner-a'),
    bUser = await makeUser('owner-b');
  const manager = await makeUser('manager-a'),
    outsider = await makeUser('outsider');
  const createBusiness = async (
    name: string,
    user: typeof aUser,
  ): Promise<ProofBusiness> => {
    const tenant = await db.admin.tenant.create({
      data: {
        slug: `tenant-proof-${name}`,
        name,
        status: 'active',
        memberships: { create: { userId: user.id, role: 'owner' } },
      },
    });
    const ground = await db.fixture.ground.create({
      data: { tenantId: tenant.id, name: `Ground ${name}` },
    });
    return {
      tenantId: tenant.id,
      userId: user.id,
      email: user.email,
      groundId: ground.id,
    };
  };
  const a = await createBusiness('a', aUser),
    b = await createBusiness('b', bUser);
  await db.admin.tenantMembership.create({
    data: { tenantId: a.tenantId, userId: manager.id, role: 'manager' },
  });
  return {
    a,
    b,
    manager: { userId: manager.id, email: manager.email },
    outsider: { userId: outsider.id, email: outsider.email },
  };
}

let day = 0;
export async function freshSlots(
  db: ProofDatabase,
  business: ProofBusiness,
  count = 2,
) {
  const date = new Date(Date.UTC(2099, 0, ++day));
  const slots = [];
  for (let index = 0; index < count; index++) {
    slots.push(
      await db.fixture.slot.create({
        data: {
          tenantId: business.tenantId,
          groundId: business.groundId,
          date,
          startHour: 8 + index,
          price: 150000,
        },
      }),
    );
  }
  return slots;
}
