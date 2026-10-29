import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../common/app-error.js';
import { AuthGuard, Roles } from './auth.guard.js';
import type { AuthService } from './auth.service.js';
import type { AuthedRequest, AuthUser } from './auth.types.js';

const manager: AuthUser = { id: 'u1', email: 'm@turf.test', name: 'M', role: 'manager' };

class OpenController { handler() {} }
class AdminController { handler() {} }
Roles('admin')(AdminController);

function run(controller: new () => { handler(): void }, authenticate: AuthService['authenticate']) {
  const req = { cookies: { admin_token: 'tok' } } as unknown as AuthedRequest;
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => controller.prototype.handler,
    getClass: () => controller,
  } as unknown as ExecutionContext;
  const guard = new AuthGuard({ authenticate } as AuthService, new Reflector());
  return { req, result: guard.canActivate(ctx) };
}

describe('AuthGuard', () => {
  it('lets a signed-in user through and attaches them to the request', async () => {
    const authenticate = vi.fn().mockResolvedValue(manager);
    const { req, result } = run(OpenController, authenticate);

    await expect(result).resolves.toBe(true);
    expect(authenticate).toHaveBeenCalledWith('tok');
    expect(req.user).toEqual(manager);
  });

  it('returns 403 when the route needs a role the user lacks', async () => {
    const { result } = run(AdminController, vi.fn().mockResolvedValue(manager));
    const err = await result.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('allows the role the route asks for', async () => {
    const { result } = run(AdminController, vi.fn().mockResolvedValue({ ...manager, role: 'admin' }));
    await expect(result).resolves.toBe(true);
  });

  it('passes on the 401 when the user is not signed in', async () => {
    const unauthenticated = new AppError('Please sign in', 401, 'UNAUTHENTICATED');
    const { result } = run(OpenController, vi.fn().mockRejectedValue(unauthenticated));
    await expect(result).rejects.toBe(unauthenticated);
  });
});
