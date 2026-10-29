import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppError } from '../common/app-error.js';
import { normalizePhone } from '../customers/phone.js';

/**
 * Limits code requests and checks per IP + phone (every request arrives through the Next.js
 * proxy, so the IP alone would be shared). Twilio Verify adds its own per-number limits.
 */
@Injectable()
export class OtpThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const phone = typeof req.body?.phone === 'string' ? normalizePhone(req.body.phone) ?? '' : '';
    return `${req.ip}:${phone}`;
  }

  protected override async throwThrottlingException(_context: ExecutionContext): Promise<void> {
    throw new AppError('Too many attempts. Try again in a few minutes.', 429, 'TOO_MANY_ATTEMPTS');
  }
}
