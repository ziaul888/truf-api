import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PlatformCommands, type PlatformTx } from './platform-command.js';
const actor = {
  userId: 'actor',
  grantId: 'grant',
  grantVersion: 3,
  userVersion: 2,
};
const command = {
  requestId: 'request',
  action: 'tenant_created' as const,
  payload: { name: 'Test' },
};
describe('platform mutation transaction boundary', () => {
  const tx = {
    platformGrant: { findUnique: vi.fn() },
    platformAuditEvent: { findUnique: vi.fn(), create: vi.fn() },
  };
  const db = { $transaction: vi.fn() };
  const work = vi.fn();
  let service: PlatformCommands;
  beforeEach(async () => {
    vi.resetAllMocks();
    tx.platformGrant.findUnique.mockResolvedValue({
      id: 'grant',
      isActive: true,
      tokenVersion: 3,
      user: { isActive: true, tokenVersion: 2 },
    });
    tx.platformAuditEvent.findUnique.mockResolvedValue(null);
    work.mockResolvedValue({
      targetId: 'turf',
      tenantId: 'turf',
      details: { status: 'draft' },
    });
    db.$transaction.mockImplementation((run: (client: PlatformTx) => unknown) =>
      run(tx as unknown as PlatformTx),
    );
    const ref = await Test.createTestingModule({
      providers: [PlatformCommands, { provide: PrismaService, useValue: db }],
    }).compile();
    service = ref.get(PlatformCommands);
  });
  it.each([
    {
      id: 'grant',
      isActive: false,
      tokenVersion: 3,
      user: { isActive: true, tokenVersion: 2 },
    },
    {
      id: 'grant',
      isActive: true,
      tokenVersion: 4,
      user: { isActive: true, tokenVersion: 2 },
    },
    {
      id: 'grant',
      isActive: true,
      tokenVersion: 3,
      user: { isActive: true, tokenVersion: 9 },
    },
    {
      id: 'grant',
      isActive: true,
      tokenVersion: 3,
      user: { isActive: false, tokenVersion: 2 },
    },
    null,
  ])('rejects revoked identity or grant before domain work', async (grant) => {
    tx.platformGrant.findUnique.mockResolvedValue(grant);
    await expect(service.run(actor, command, work)).rejects.toMatchObject({
      status: 403,
      code: 'PLATFORM_ACCESS_DENIED',
    });
    expect(work).not.toHaveBeenCalled();
    expect(tx.platformAuditEvent.create).not.toHaveBeenCalled();
  });
  it('rechecks authority before replaying a completed request', async () => {
    tx.platformGrant.findUnique.mockResolvedValue(null);
    tx.platformAuditEvent.findUnique.mockResolvedValue({ targetId: 'turf' });
    await expect(service.run(actor, command, work)).rejects.toMatchObject({
      status: 403,
    });
    expect(tx.platformAuditEvent.findUnique).not.toHaveBeenCalled();
  });
  it('records only successful commands in the same serializable transaction', async () => {
    expect(await service.run(actor, command, work)).toBe('turf');
    expect(db.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
    expect(tx.platformAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: actor.userId,
        targetId: 'turf',
        tenantId: 'turf',
        action: command.action,
      }),
    });
    work.mockRejectedValue(new Error('domain validation failed'));
    tx.platformAuditEvent.create.mockClear();
    await expect(service.run(actor, command, work)).rejects.toThrow(
      'domain validation failed',
    );
    expect(tx.platformAuditEvent.create).not.toHaveBeenCalled();
  });
  it('bounds serialization retries and returns a conflict without exposing database errors', async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError(
      'serialization details',
      { code: 'P2034', clientVersion: 'test' },
    );
    db.$transaction.mockRejectedValue(conflict);
    await expect(service.run(actor, command, work)).rejects.toMatchObject({
      status: 409,
      code: 'PLATFORM_CONFLICT',
    });
    expect(db.$transaction).toHaveBeenCalledTimes(4);
  });
  it('does not retry unrelated failures', async () => {
    const error = new Error('unrelated');
    db.$transaction.mockRejectedValue(error);
    await expect(service.run(actor, command, work)).rejects.toBe(error);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});
