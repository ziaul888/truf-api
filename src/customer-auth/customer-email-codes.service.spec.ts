import type { EmailService } from '../email/email.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { CustomerEmailCodesService } from './customer-email-codes.service.js';
import { CustomerEmailAuthService } from './customer-email-auth.service.js';
import type { CustomerAuthService } from './customer-auth.service.js';

const target = {
  purpose: 'sign-in' as const,
  email: 'player@example.test',
  customerId: 'customer',
  sessionVersion: 0,
  emailVersion: 1,
};

function setup() {
  const table = {
    createMany: vi.fn().mockResolvedValue({ count: 1 }),
    deleteMany: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  const email = { configured: true, send: vi.fn().mockResolvedValue(true) };
  const service = new CustomerEmailCodesService(
    { customerEmailCode: table } as unknown as PrismaService,
    email as unknown as EmailService,
  );
  return { table, email, service };
}

describe('CustomerEmailCodesService', () => {
  it('stores a digest and sends only one email during the resend window', async () => {
    const { table, email, service } = setup();
    await service.send(target);
    const text: string = email.send.mock.calls[0][0].text;
    const code = text.match(/\b\d{6}\b/)?.[0];
    expect(code).toBeTruthy();
    expect(table.createMany.mock.calls[0][0].data.digest).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(table.createMany.mock.calls[0][0].data.digest).not.toBe(code);
    table.createMany.mockResolvedValueOnce({ count: 0 });
    await service.send(target);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(table.updateMany.mock.calls[0][0].where.resendAt.lte).toBeInstanceOf(
      Date,
    );
  });

  it('applies the same attempt budget and expiry to valid and invalid codes', async () => {
    const { table, service } = setup();
    expect(await service.consume(target, '012345')).toBe(false);
    const [claim, failedAttempt] = table.updateMany.mock.calls.map(
      ([query]) => query,
    );
    expect(claim.where).toMatchObject({
      attempts: { lt: 5 },
      expiresAt: { gt: expect.any(Date) },
      digest: expect.any(String),
    });
    expect(claim.data).toEqual({ attempts: 5 });
    expect(failedAttempt.where).toEqual({
      attempts: claim.where.attempts,
      expiresAt: claim.where.expiresAt,
      key: claim.where.key,
    });
    expect(failedAttempt.data).toEqual({ attempts: { increment: 1 } });
  });
});

describe('CustomerEmailAuthService', () => {
  it('sends a first-time sign-in code without creating a customer before verification', async () => {
    const customer = {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    };
    const codes = {
      assertConfigured: vi.fn(),
      send: vi.fn().mockResolvedValue(true),
    };
    const service = new CustomerEmailAuthService(
      { customer } as unknown as PrismaService,
      {} as CustomerAuthService,
      codes as unknown as CustomerEmailCodesService,
    );
    await expect(service.sendSignInCode(target.email)).resolves.toEqual({
      sent: true,
    });
    expect(customer.findUnique).toHaveBeenCalledWith({
      where: { verifiedEmail: target.email, deletedAt: null },
    });
    expect(codes.send).toHaveBeenCalledWith({
      purpose: 'sign-in',
      email: target.email,
    });
    expect(customer.create).not.toHaveBeenCalled();
  });
});
