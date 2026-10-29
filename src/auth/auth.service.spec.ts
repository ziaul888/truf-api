import { JwtService } from '@nestjs/jwt';
import { AppError } from '../common/app-error.js';
import type { User } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AuthService } from './auth.service.js';
import { hashPassword } from './password.js';

const jwt = new JwtService({ secret: 'test-secret-that-is-long-enough-1234567890' });

async function makeUser(overrides: Partial<User> = {}): Promise<User> {
  return {
    id: 'user-1',
    email: 'admin@turf.test',
    name: 'Admin',
    role: 'admin',
    isActive: true,
    tokenVersion: 0,
    passwordHash: await hashPassword('s3cret-password'),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function setup(user: User | null) {
  const findUnique = vi.fn().mockResolvedValue(user);
  const update = vi.fn(async ({ data }: { data: { passwordHash: string } }) => ({
    ...user!, passwordHash: data.passwordHash, tokenVersion: user!.tokenVersion + 1,
  }));
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = { user: { findUnique, update, updateMany } } as unknown as PrismaService;
  return { service: new AuthService(prisma, jwt), findUnique, update, updateMany };
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect(err).toMatchObject({ status, code });
}

describe('AuthService.login', () => {
  it('returns the user without the hash, and a token for them', async () => {
    const { service } = setup(await makeUser());
    const { user, token } = await service.login({ email: 'admin@turf.test', password: 's3cret-password' });

    expect(user).toEqual({ id: 'user-1', email: 'admin@turf.test', name: 'Admin', role: 'admin' });
    expect(await jwt.verifyAsync(token)).toMatchObject({ sub: 'user-1', role: 'admin', ver: 0 });
  });

  it('rejects a wrong password', async () => {
    const { service } = setup(await makeUser());
    await expectAppError(service.login({ email: 'admin@turf.test', password: 'nope' }), 401, 'INVALID_CREDENTIALS');
  });

  it('rejects an unknown email with the same error', async () => {
    const { service } = setup(null);
    await expectAppError(service.login({ email: 'who@turf.test', password: 'x' }), 401, 'INVALID_CREDENTIALS');
  });

  it('rejects a deactivated user even with the right password', async () => {
    const { service } = setup(await makeUser({ isActive: false }));
    await expectAppError(
      service.login({ email: 'admin@turf.test', password: 's3cret-password' }),
      401,
      'INVALID_CREDENTIALS',
    );
  });
});

describe('AuthService.authenticate', () => {
  it('returns the current user for a valid token', async () => {
    const { service, findUnique } = setup(await makeUser({ role: 'manager' }));
    const token = await jwt.signAsync({ sub: 'user-1', role: 'admin', ver: 0 });

    // Role comes from the database, not the (possibly stale) token.
    await expect(service.authenticate(token)).resolves.toMatchObject({ id: 'user-1', role: 'manager' });
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' } });
  });

  it.each([
    ['a missing token', undefined],
    ['a garbage token', 'not-a-jwt'],
  ])('rejects %s', async (_label, token) => {
    const { service } = setup(await makeUser());
    await expectAppError(service.authenticate(token), 401, 'UNAUTHENTICATED');
  });

  it('rejects a token signed with another secret', async () => {
    const { service } = setup(await makeUser());
    const forged = await new JwtService({ secret: 'some-other-secret-1234567890-abcdef' }).signAsync({ sub: 'user-1' });
    await expectAppError(service.authenticate(forged), 401, 'UNAUTHENTICATED');
  });

  it('rejects a user deactivated after login', async () => {
    const { service } = setup(await makeUser({ isActive: false }));
    const token = await jwt.signAsync({ sub: 'user-1', role: 'admin', ver: 0 });
    await expectAppError(service.authenticate(token), 401, 'UNAUTHENTICATED');
  });
});

describe('token revocation', () => {
  it('rejects a token issued before the user\'s token version was bumped', async () => {
    const { service } = setup(await makeUser({ tokenVersion: 1 }));
    const oldToken = await jwt.signAsync({ sub: 'user-1', role: 'admin', ver: 0 });
    await expectAppError(service.authenticate(oldToken), 401, 'UNAUTHENTICATED');
  });

  it('logout bumps the version of the token\'s user only if it is still current', async () => {
    const { service, updateMany } = setup(await makeUser());
    await service.logout(await jwt.signAsync({ sub: 'user-1', role: 'admin', ver: 0 }));
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1', tokenVersion: 0 },
      data: { tokenVersion: { increment: 1 } },
    });
  });

  it('logout with no or a bad token does nothing', async () => {
    const { service, updateMany } = setup(await makeUser());
    await service.logout(undefined);
    await service.logout('garbage');
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('AuthService.changePassword', () => {
  it('saves a new hash, bumps the version and returns a token for the new version', async () => {
    const { service, update } = setup(await makeUser());
    const token = await service.changePassword('user-1', {
      currentPassword: 's3cret-password', newPassword: 'brand-new-password',
    });

    const { data } = update.mock.calls[0]![0];
    expect(data.passwordHash).not.toContain('brand-new-password');
    expect(data).toMatchObject({ tokenVersion: { increment: 1 } });
    expect(await jwt.verifyAsync(token)).toMatchObject({ sub: 'user-1', ver: 1 });
  });

  it('rejects a wrong current password with 400, not 401', async () => {
    const { service, update } = setup(await makeUser());
    await expectAppError(
      service.changePassword('user-1', { currentPassword: 'nope', newPassword: 'brand-new-password' }),
      400,
      'WRONG_PASSWORD',
    );
    expect(update).not.toHaveBeenCalled();
  });
});
