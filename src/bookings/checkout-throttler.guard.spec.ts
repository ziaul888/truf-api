import { Reflector } from '@nestjs/core';
import type { ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';
import type { CustomerAuthService } from '../customer-auth/customer-auth.service.js';
import type { CustomerSession } from '../customer-auth/customer-auth.types.js';
import { CheckoutThrottlerGuard } from './checkout-throttler.guard.js';

const session: CustomerSession = { phone: '+8801711999999', customerId: 'c-1', name: 'Rakib', email: 'r@x.test', needsProfile: false };

function tracker(req: Record<string, unknown>, signedIn: CustomerSession | null = null) {
  const optional = vi.fn(async (_token: string | undefined) => signedIn);
  const guard = new CheckoutThrottlerGuard(
    [] as ThrottlerModuleOptions, {} as ThrottlerStorage, new Reflector(), { optional } as unknown as CustomerAuthService,
  );
  const getTracker = (guard as unknown as { getTracker(r: Record<string, unknown>): Promise<string> }).getTracker.bind(guard);
  return { result: getTracker({ ip: '10.0.0.1', ...req }), optional };
}

describe('CheckoutThrottlerGuard', () => {
  it('keys a guest on IP + the normalised phone from the body', async () => {
    await expect(tracker({ body: { customerPhone: '01711 000000' } }).result).resolves.toBe('10.0.0.1:+8801711000000');
  });

  it('keys a signed-in customer on IP + their verified phone, whatever the body says', async () => {
    const { result, optional } = tracker({ cookies: { customer_token: 'tok' }, body: { customerPhone: '01700000000' } }, session);
    await expect(result).resolves.toBe('10.0.0.1:+8801711999999');
    expect(optional).toHaveBeenCalledWith('tok');
  });

  it('falls back to the IP alone when there is no usable phone', async () => {
    await expect(tracker({ body: { customerPhone: 12 } }).result).resolves.toBe('10.0.0.1:');
    await expect(tracker({ body: { customerPhone: '12' } }).result).resolves.toBe('10.0.0.1:');
    await expect(tracker({}).result).resolves.toBe('10.0.0.1:');
  });

  it('refuses with 429 TOO_MANY_ATTEMPTS', async () => {
    const guard = new CheckoutThrottlerGuard([] as ThrottlerModuleOptions, {} as ThrottlerStorage, new Reflector(), {} as CustomerAuthService);
    const thrown = (guard as unknown as { throwThrottlingException(): Promise<void> }).throwThrottlingException();
    await expect(thrown).rejects.toMatchObject({ status: 429, code: 'TOO_MANY_ATTEMPTS' });
  });
});
