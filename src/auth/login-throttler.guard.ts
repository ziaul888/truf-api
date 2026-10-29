import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppError } from '../common/app-error.js';

/**
 * Limits login attempts per IP + email. Keying on the email matters because every request
 * arrives through the Next.js proxy, so the IP alone would be shared by all users.
 */
@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return `${req.ip}:${email}`;
  }

  protected override async throwThrottlingException(_context: ExecutionContext): Promise<void> {
    throw new AppError('Too many login attempts. Try again in a minute.', 429, 'TOO_MANY_ATTEMPTS');
  }
}
