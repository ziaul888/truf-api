import { JwtService } from '@nestjs/jwt';
import type { Customer } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SmsVerifyService } from '../sms/sms-verify.service.js';
import { CustomerAuthService } from './customer-auth.service.js';

const jwt = new JwtService({
  secret: 'test-secret-that-is-long-enough-1234567890:customer',
  signOptions: { audience: 'customer' },
  verifyOptions: { audience: 'customer' },
});
const PHONE = '+8801711000000';

const customerRow = (overrides: Partial<Customer> = {}): Customer => ({
  id: 'c-1', name: 'Rakib', email: 'r@x.test', phone: PHONE, stripeCustomerId: null, adminNote: 'staff only',
  sessionVersion: 0, createdAt: new Date(), updatedAt: new Date(), deletedAt: null, ...overrides,
});

function setup(customer: Customer | null, codeOk = true) {
  const prisma = {
    customer: { findUnique: vi.fn(async () => customer), updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const sms = { send: vi.fn(async () => undefined), check: vi.fn(async () => codeOk) };
  const service = new CustomerAuthService(prisma as unknown as PrismaService, jwt, sms as unknown as SmsVerifyService);
  return { service, prisma, sms };
}

describe('CustomerAuthService', () => {
  it('sends a code by SMS', async () => {
    const { service, sms } = setup(null);
    expect(await service.sendCode(PHONE)).toEqual({ sent: true });
    expect(sms.send).toHaveBeenCalledWith(PHONE);
  });

  it('signs in a known customer with the right code, without staff-only fields', async () => {
    const { service } = setup(customerRow({ sessionVersion: 3 }));
    const { session, token } = await service.verify(PHONE, '123456');

    expect(session).toEqual({ phone: PHONE, customerId: 'c-1', name: 'Rakib', email: 'r@x.test' });
    expect(await jwt.verifyAsync(token)).toMatchObject({ sub: PHONE, ver: 3, aud: 'customer' });
  });

  it('signs in a number with no customer record yet', async () => {
    const { service } = setup(null);
    const { session } = await service.verify(PHONE, '123456');
    expect(session).toEqual({ phone: PHONE, customerId: null, name: null, email: null });
  });

  it('rejects a wrong or expired code', async () => {
    const { service } = setup(customerRow(), false);
    await expect(service.verify(PHONE, '000000')).rejects.toMatchObject({ status: 400, code: 'INVALID_CODE' });
  });

  it('authenticates a valid token, and rejects one revoked by sign-out', async () => {
    const token = await jwt.signAsync({ sub: PHONE, ver: 0 });
    expect(await setup(customerRow()).service.authenticate(token)).toMatchObject({ customerId: 'c-1' });
    await expect(setup(customerRow({ sessionVersion: 1 })).service.authenticate(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a staff token', async () => {
    const staffToken = await new JwtService({ secret: 'test-secret-that-is-long-enough-1234567890' }).signAsync({ sub: 'u-1', ver: 0 });
    await expect(setup(customerRow()).service.authenticate(staffToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('returns null for an optional session that is missing or bad', async () => {
    const { service } = setup(customerRow());
    expect(await service.optional(undefined)).toBeNull();
    expect(await service.optional('garbage')).toBeNull();
  });

  it('logout revokes every session for the phone', async () => {
    const { service, prisma } = setup(customerRow());
    await service.logout(await jwt.signAsync({ sub: PHONE, ver: 2 }));
    expect(prisma.customer.updateMany).toHaveBeenCalledWith({
      where: { phone: PHONE, sessionVersion: 2 }, data: { sessionVersion: { increment: 1 } },
    });
  });
});
