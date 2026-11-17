import { resolveTenantAccess, type MembershipReader } from './tenant-access.js';

const userId = 'user-a';
const tenantId = 'tenant-a';
type Access = NonNullable<Awaited<ReturnType<MembershipReader['findUnique']>>>;
const membership = (changes: Partial<Access> = {}): Access => ({
  tenantId,
  userId,
  role: 'owner',
  isActive: true,
  tenant: { status: 'active' },
  user: { isActive: true },
  ...changes,
});
const reader = (value: Access | null): MembershipReader => ({
  findUnique: vi.fn(async () => value),
});

describe('tenant access', () => {
  it('requires an explicit active membership and returns immutable context', async () => {
    const context = await resolveTenantAccess(
      reader(membership()),
      userId,
      tenantId,
      ['owner'],
    );
    expect(context).toEqual({ tenantId, userId, role: 'owner' });
    expect(Object.isFrozen(context)).toBe(true);
  });

  it.each([
    null,
    membership({ isActive: false }),
    membership({ user: { isActive: false } }),
    membership({ userId: 'other-user' }),
    membership({ tenantId: 'other-tenant' }),
  ])('denies missing, revoked or mismatched access: %j', async (value) => {
    await expect(
      resolveTenantAccess(reader(value), userId, tenantId),
    ).rejects.toMatchObject({ status: 403, code: 'TENANT_ACCESS_DENIED' });
  });

  it.each(['draft', 'suspended', 'archived'] as const)(
    'denies a %s tenant',
    async (status) => {
      await expect(
        resolveTenantAccess(
          reader(membership({ tenant: { status } })),
          userId,
          tenantId,
        ),
      ).rejects.toMatchObject({ code: 'TENANT_UNAVAILABLE' });
    },
  );

  it('uses the membership role for restricted actions', async () => {
    await expect(
      resolveTenantAccess(
        reader(membership({ role: 'manager' })),
        userId,
        tenantId,
        ['owner'],
      ),
    ).rejects.toMatchObject({ code: 'TENANT_ROLE_REQUIRED' });
  });

  it('allows explicitly permitted roles and checks the requested membership key', async () => {
    const source = reader(membership({ role: 'manager' }));
    await expect(
      resolveTenantAccess(source, userId, tenantId, ['admin', 'manager']),
    ).resolves.toMatchObject({ role: 'manager' });
    expect(source.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_userId: { tenantId, userId } },
      }),
    );
  });
});
