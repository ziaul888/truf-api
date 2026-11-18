import { ownerContext, type OwnerMembership } from './owner-access.js';
const session = { sub: 'owner', tid: 'turf', mid: 'membership', uv: 3, mv: 2 };
function membership(): OwnerMembership {
  return {
    id: 'membership',
    userId: 'owner',
    tenantId: 'turf',
    role: 'owner',
    isActive: true,
    tokenVersion: 2,
    createdAt: new Date(),
    user: {
      id: 'owner',
      email: 'owner@example.test',
      name: 'Owner',
      role: 'manager',
      isActive: true,
      legacyStaffAccess: false,
      tokenVersion: 3,
      createdAt: new Date(),
    },
    tenant: {
      id: 'turf',
      name: 'Own turf',
      slug: 'own-turf',
      status: 'draft',
      timezone: 'Asia/Dhaka',
      currency: 'bdt',
      createdAt: new Date(),
      setup: null,
    },
  };
}
describe('owner session binding', () => {
  it('returns a safe owner account with an immutable membership snapshot', () => {
    const result = ownerContext(membership(), session);
    expect(result.user).toMatchObject({
      audience: 'owner',
      role: 'owner',
      tenant: { id: 'turf', status: 'draft' },
    });
    expect(Object.isFrozen(result.session)).toBe(true);
    expect(result.user).not.toHaveProperty('legacyStaffAccess');
  });
  it.each([
    { sub: 'someone' },
    { tid: 'foreign-turf' },
    { mid: 'foreign-membership' },
    { uv: 1 },
    { mv: 1 },
  ])(
    'rejects claims bound to a different identity, turf or session',
    (change) => {
      expect(() =>
        ownerContext(membership(), { ...session, ...change }),
      ).toThrowError(
        expect.objectContaining({ code: 'OWNER_UNAUTHENTICATED' }),
      );
    },
  );
  it.each(['revoked', 'role', 'identity', 'legacy', 'archive'] as const)(
    'denies %s access',
    (kind) => {
      const row = membership();
      if (kind === 'revoked') row.isActive = false;
      if (kind === 'role') row.role = 'manager';
      if (kind === 'identity') row.user.isActive = false;
      if (kind === 'legacy') row.user.legacyStaffAccess = true;
      if (kind === 'archive') row.tenant.status = 'archived';
      expect(() => ownerContext(row, session)).toThrowError(
        expect.objectContaining({ status: 401 }),
      );
    },
  );
  it('allows paused account metadata without implying operational access', () => {
    const row = membership();
    row.tenant.status = 'suspended';
    expect(ownerContext(row, session).user.tenant.status).toBe('suspended');
  });
});
