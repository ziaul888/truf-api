import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../auth/auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlatformAuthService } from './platform-auth.service.js';

const userId = '11111111-1111-4111-8111-111111111111';
const grantId = '22222222-2222-4222-8222-222222222222';
const input = { email: 'owner@example.test', password: 'test-only-password' };
const person = {
  id: userId,
  name: 'Platform Owner',
  email: input.email,
  isActive: true,
  tokenVersion: 2,
  role: 'manager',
};

describe('platform authentication boundary', () => {
  const auth = { verifyCredentials: vi.fn() };
  const db = { platformGrant: { findUnique: vi.fn(), updateMany: vi.fn() } };
  const jwt = { signAsync: vi.fn(), verifyAsync: vi.fn() };
  let service: PlatformAuthService;
  beforeEach(async () => {
    vi.resetAllMocks();
    auth.verifyCredentials.mockResolvedValue(person);
    db.platformGrant.findUnique.mockResolvedValue({
      id: grantId,
      userId,
      isActive: true,
      tokenVersion: 3,
      user: person,
    });
    jwt.signAsync.mockResolvedValue('test-session');
    jwt.verifyAsync.mockResolvedValue({
      sub: userId,
      gid: grantId,
      ver: 3,
      uv: 2,
    });
    const ref = await Test.createTestingModule({
      providers: [
        PlatformAuthService,
        { provide: AuthService, useValue: auth },
        { provide: PrismaService, useValue: db },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();
    service = ref.get(PlatformAuthService);
  });
  it('rejects credentials invalidated before the grant lookup completes', async () => {
    db.platformGrant.findUnique.mockResolvedValue({
      id: grantId,
      isActive: true,
      tokenVersion: 3,
      user: { ...person, tokenVersion: 4 },
    });
    await expect(service.login(input)).rejects.toMatchObject({
      status: 401,
      code: 'PLATFORM_UNAUTHENTICATED',
    });
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });
  it('does not derive platform authority from a global admin role', async () => {
    auth.verifyCredentials.mockResolvedValue({ ...person, role: 'admin' });
    db.platformGrant.findUnique.mockResolvedValue(null);
    await expect(service.login(input)).rejects.toMatchObject({
      status: 403,
      code: 'PLATFORM_ACCESS_DENIED',
    });
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });
  it('issues claims bound to both the access grant and user session version', async () => {
    const result = await service.login(input);
    expect(result.user).toEqual({
      id: userId,
      name: person.name,
      email: person.email,
      role: 'platform_admin',
    });
    expect(jwt.signAsync).toHaveBeenCalledWith({
      sub: userId,
      gid: grantId,
      ver: 3,
      uv: 2,
    });
  });
  it('rejects a token bound to a different grant', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: userId,
      gid: userId,
      ver: 3,
      uv: 2,
    });
    await expect(service.authenticate('session')).rejects.toMatchObject({
      status: 401,
    });
  });
  it('rejects a rotated grant session version', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: userId,
      gid: grantId,
      ver: 2,
      uv: 2,
    });
    await expect(service.authenticate('session')).rejects.toMatchObject({
      status: 401,
    });
  });
  it('rejects malformed claims before any access lookup', async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: userId });
    await expect(service.authenticate('session')).rejects.toMatchObject({
      status: 401,
    });
    expect(db.platformGrant.findUnique).not.toHaveBeenCalled();
  });
  it('keeps verification failures inside the unauthenticated response', async () => {
    jwt.verifyAsync.mockRejectedValue(new Error('invalid signature'));
    await expect(service.authenticate('session')).rejects.toMatchObject({
      status: 401,
      code: 'PLATFORM_UNAUTHENTICATED',
    });
    expect(db.platformGrant.findUnique).not.toHaveBeenCalled();
  });
});
