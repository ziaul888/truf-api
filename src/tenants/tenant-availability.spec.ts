import { Prisma } from '../generated/prisma/client.js';
import { withTenantAvailability } from './tenant-availability.js';
import { ListMyTenantAccountsSchema } from './tenant-accounts.schemas.js';

describe('tenant account availability', () => {
  it.each(['P2021', 'P2022'])(
    'returns a safe unavailable state for %s',
    async (code) => {
      await expect(
        withTenantAvailability(async () => {
          throw new Prisma.PrismaClientKnownRequestError(
            'Missing foundation schema',
            { code, clientVersion: 'test' },
          );
        }),
      ).rejects.toMatchObject({
        status: 503,
        code: 'TENANT_WORKSPACES_UNAVAILABLE',
      });
    },
  );

  it('does not disguise unrelated failures', async () => {
    const error = new Error('Connection interrupted');
    await expect(
      withTenantAvailability(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  it('preserves successful reads', async () => {
    expect(await withTenantAvailability(async () => ['business-a'])).toEqual([
      'business-a',
    ]);
  });
});

describe('tenant account filters', () => {
  it('normalizes search and supplies bounded pagination', () => {
    expect(
      ListMyTenantAccountsSchema.parse({ search: '  Greenfield  ', page: '2' }),
    ).toEqual({ search: 'Greenfield', page: 2, limit: 20 });
  });

  it.each([
    { page: 0 },
    { limit: 101 },
    { status: 'unknown' },
    { search: 'a'.repeat(101) },
  ])('rejects invalid filters: %j', (input) => {
    expect(ListMyTenantAccountsSchema.safeParse(input).success).toBe(false);
  });

  it('does not accept another user identity as a filter', () => {
    expect(
      ListMyTenantAccountsSchema.parse({ userId: 'someone-else' }),
    ).toEqual({ page: 1, limit: 20 });
  });
});
