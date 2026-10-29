import { randomInt } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { env } from '../config/env.js';

const VERIFY_API = 'https://verify.twilio.com/v2/Services';
/** Dev fallback only: Twilio Verify applies its own expiry and attempt limits. */
const DEV_CODE_TTL_MS = 10 * 60_000;
const DEV_MAX_ATTEMPTS = 5;

const providerError = () => new AppError("We couldn't send the code. Please try again shortly", 502, 'SMS_PROVIDER_ERROR');
const tooManyCodes = () => new AppError('Too many codes requested for this number. Try again later', 429, 'TOO_MANY_CODES');

/**
 * Sends and checks one-time sign-in codes by SMS through Twilio Verify, which generates, stores,
 * expires and rate-limits the codes. Without Twilio settings (dev only), codes are kept in memory
 * and logged instead of sent. With TEST_OTP_CODE (never in production), that fixed code always
 * works and no SMS is sent. Tests mock it. Never log codes when Twilio is configured.
 */
@Injectable()
export class SmsVerifyService {
  private readonly logger = new Logger(SmsVerifyService.name);
  private readonly devCodes = new Map<string, { code: string; expiresAt: number; attempts: number }>();

  /** `phone` is normalised E.164 ("+8801711000000"). */
  async send(phone: string): Promise<void> {
    if (env.TEST_OTP_CODE) return this.logger.warn(`TEST_OTP_CODE is set: no SMS sent to ${phone}`);
    if (!this.configured()) return this.devSend(phone);
    const res = await this.call('Verifications', { To: phone, Channel: 'sms' });
    if (res.ok) return;
    const { code } = await res.json().catch(() => ({ code: undefined }));
    if (res.status === 429 || code === 60203) throw tooManyCodes();
    if (code === 60200 || code === 60205) throw new AppError('This number cannot receive SMS', 400, 'INVALID_PHONE');
    this.logger.error(`Twilio Verify send failed: HTTP ${res.status}, code ${code}`);
    throw providerError();
  }

  /** True when the code is right. A wrong, expired or used-up code is just false. */
  async check(phone: string, code: string): Promise<boolean> {
    if (env.TEST_OTP_CODE) return code === env.TEST_OTP_CODE;
    if (!this.configured()) return this.devCheck(phone, code);
    const res = await this.call('VerificationCheck', { To: phone, Code: code });
    // 404: no pending verification (expired, already used, or too many wrong attempts).
    if (res.status === 404) return false;
    if (!res.ok) {
      this.logger.error(`Twilio Verify check failed: HTTP ${res.status}`);
      throw providerError();
    }
    const body = (await res.json()) as { status?: string };
    return body.status === 'approved';
  }

  private configured(): boolean {
    return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID);
  }

  private async call(path: string, form: Record<string, string>): Promise<Response> {
    const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
    try {
      return await fetch(`${VERIFY_API}/${env.TWILIO_VERIFY_SERVICE_SID}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.logger.error('Twilio Verify unreachable', err instanceof Error ? err.message : String(err));
      throw providerError();
    }
  }

  private devSend(phone: string) {
    if (env.NODE_ENV === 'production') {
      this.logger.error('Twilio Verify is not configured (TWILIO_* env vars)');
      throw providerError();
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.devCodes.set(phone, { code, expiresAt: Date.now() + DEV_CODE_TTL_MS, attempts: 0 });
    this.logger.warn(`Twilio not configured, sign-in code for ${phone}: ${code}`);
  }

  private devCheck(phone: string, code: string): boolean {
    const entry = this.devCodes.get(phone);
    if (!entry || entry.expiresAt < Date.now() || ++entry.attempts > DEV_MAX_ATTEMPTS) return false;
    if (entry.code !== code) return false;
    this.devCodes.delete(phone);
    return true;
  }
}
