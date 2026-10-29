import { AppError } from '../common/app-error.js';
import type { User } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from './users.service.js';

const user = (overrides: Partial<User> = {}): User => ({
  id: 'u-1',
  email: 'manager@turf.test',
  name: 'Manager',
  role: 'manager',
  isActive: true,
  tokenVersion: 0,
  passwordHash: 'scrypt$hash',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  ...overrides,
});

function setup(existing: Record<string, User> = {}) {
  const byKey = (where: { id?: string; email?: string }) =>
    Object.values(existing).find((u) => u.id === where.id || u.email === where.email) ?? null;
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }) => byKey(where)),
      findMany: vi.fn(async () => Object.values(existing)),
      count: vi.fn(async () => Object.keys(existing).length),
      create: vi.fn(async ({ data }) => user({ ...data, id: 'new-id' })),
      update: vi.fn(async ({ where, data }) => ({ ...byKey(where)!, ...data })),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { service: new UsersService(prisma as unknown as PrismaService), prisma };
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect(err).toMatchObject({ status, code });
}

describe('UsersService', () => {
  it('lists users as DTOs with pagination, searching name and email', async () => {
    const { service, prisma } = setup({ a: user() });
    const result = await service.list({ page: 2, limit: 10, search: 'man' });

    expect(result).toMatchObject({ total: 1, page: 2, limit: 10 });
    expect(result.data[0]).not.toHaveProperty('passwordHash');
    expect(result.data[0]).not.toHaveProperty('tokenVersion');
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 10,
      take: 10,
      where: { OR: [
        { name: { contains: 'man', mode: 'insensitive' } },
        { email: { contains: 'man', mode: 'insensitive' } },
      ] },
    }));
  });

  it('returns 404 for an unknown id', async () => {
    await expectAppError(setup().service.get('missing'), 404, 'USER_NOT_FOUND');
  });

  it('creates a user with a hashed password', async () => {
    const { service, prisma } = setup();
    const dto = await service.create({ email: 'new@turf.test', name: 'New', password: 'long-password-1', role: 'manager' });

    expect(dto).toMatchObject({ id: 'new-id', email: 'new@turf.test', role: 'manager' });
    const { data } = prisma.user.create.mock.calls[0]![0];
    expect(data.passwordHash).toMatch(/^scrypt\$/);
    expect(data).not.toHaveProperty('password');
  });

  it('rejects a duplicate email with 409', async () => {
    const { service } = setup({ a: user() });
    await expectAppError(
      service.create({ email: 'manager@turf.test', name: 'Dup', password: 'long-password-1', role: 'manager' }),
      409,
      'EMAIL_TAKEN',
    );
  });

  it('maps a unique-constraint race on create to 409', async () => {
    const { service, prisma } = setup();
    prisma.user.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expectAppError(
      service.create({ email: 'race@turf.test', name: 'Race', password: 'long-password-1', role: 'manager' }),
      409,
      'EMAIL_TAKEN',
    );
  });

  it('lets an admin change another user\'s role and status', async () => {
    const { service } = setup({ a: user() });
    await expect(service.update('admin-id', 'u-1', { role: 'admin', isActive: false }))
      .resolves.toMatchObject({ role: 'admin', isActive: false });
  });

  it.each([
    ['demote themselves', { role: 'manager' as const }],
    ['deactivate themselves', { isActive: false }],
  ])('stops an admin from trying to %s', async (_label, input) => {
    const { service } = setup({ a: user({ id: 'admin-id', role: 'admin' }) });
    await expectAppError(service.update('admin-id', 'admin-id', input), 400, 'CANNOT_CHANGE_OWN_ACCESS');
  });

  it('lets an admin edit their own name, and send unchanged role/status', async () => {
    const { service } = setup({ a: user({ id: 'admin-id', role: 'admin' }) });
    await expect(service.update('admin-id', 'admin-id', { name: 'Boss', role: 'admin', isActive: true }))
      .resolves.toMatchObject({ name: 'Boss' });
  });

  it('rejects changing an email to one that is taken', async () => {
    const { service } = setup({ a: user(), b: user({ id: 'u-2', email: 'other@turf.test' }) });
    await expectAppError(service.update('admin-id', 'u-1', { email: 'other@turf.test' }), 409, 'EMAIL_TAKEN');
  });

  it('reset-password stores a new hash and revokes existing sessions', async () => {
    const { service, prisma } = setup({ a: user() });
    await service.resetPassword('u-1', { password: 'a-new-long-password' });

    const { data } = prisma.user.update.mock.calls[0]![0];
    expect(data.passwordHash).toMatch(/^scrypt\$/);
    expect(data.tokenVersion).toEqual({ increment: 1 });
  });
});
