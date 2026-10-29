import { ArgumentsHost, Logger, NotFoundException } from '@nestjs/common';
import { AppError } from '../app-error.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

function mockHost() {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  return { host, res };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('maps AppError to its status, message and code', () => {
    const { host, res } = mockHost();
    filter.catch(new AppError('That slot was just taken', 409, 'SLOT_UNAVAILABLE'), host);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'That slot was just taken', code: 'SLOT_UNAVAILABLE' });
  });

  it('maps Nest HTTP exceptions', () => {
    const { host, res } = mockHost();
    filter.catch(new NotFoundException('Ground not found'), host);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Ground not found' });
  });

  it('hides unknown errors behind a generic 500', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host, res } = mockHost();
    filter.catch(new Error('db password is hunter2'), host);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Internal server error' });
  });
});
