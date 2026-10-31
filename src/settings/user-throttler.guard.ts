import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth.types.js';
import { AppError } from '../common/app-error.js';

/** Per signed-in user (use after AuthGuard). For the test email: 5 an hour. */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    return (req as AuthedRequest).user?.id ?? req.ip;
  }

  protected override async throwThrottlingException(_context: ExecutionContext): Promise<void> {
    throw new AppError('Too many test emails. Try again later.', 429, 'TOO_MANY_ATTEMPTS');
  }
}
