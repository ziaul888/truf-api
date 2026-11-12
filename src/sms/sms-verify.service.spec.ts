import { env } from '../config/env.js';
import { SmsVerifyService } from './sms-verify.service.js';

const PHONE = '+8801711000000';
const twilio = { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'secret', TWILIO_VERIFY_SERVICE_SID: 'VA123' };
const originalNodeEnv = env.NODE_ENV;

const json = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('SmsVerifyService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of [...Object.keys(twilio), 'TEST_OTP_CODE', 'LIVE_TEST_PHONE', 'LIVE_TEST_OTP']) delete (env as Record<string, unknown>)[key];
    env.NODE_ENV = originalNodeEnv;
  });

  describe('without Twilio (dev)', () => {
    it('logs a code and accepts it once', async () => {
      const service = new SmsVerifyService();
      const warn = vi.spyOn((service as unknown as { logger: { warn: (msg: string) => void } }).logger, 'warn').mockImplementation(() => undefined);
      await service.send(PHONE);
      const code = String(warn.mock.calls[0]![0]).match(/(\d{6})$/)![1]!;

      expect(await service.check(PHONE, '999999' === code ? '000000' : '999999')).toBe(false);
      expect(await service.check(PHONE, code)).toBe(true);
      expect(await service.check(PHONE, code)).toBe(false);
    });
  });

  it('with TEST_OTP_CODE, sends nothing and accepts only that code', async () => {
    Object.assign(env, twilio, { TEST_OTP_CODE: '13456' });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const service = new SmsVerifyService();
    await service.send(PHONE);
    expect(await service.check(PHONE, '13456')).toBe(true);
    expect(await service.check(PHONE, '123456')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  describe('with Twilio Verify', () => {
    beforeEach(() => Object.assign(env, twilio));

    it('sends through the Verify API with basic auth', async () => {
      const fetch = vi.fn(async () => json(201, { status: 'pending' }));
      vi.stubGlobal('fetch', fetch);
      await new SmsVerifyService().send(PHONE);

      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://verify.twilio.com/v2/Services/VA123/Verifications');
      expect(String(init.body)).toBe('To=%2B8801711000000&Channel=sms');
      expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('AC123:secret').toString('base64')}`);
    });

    it('maps Twilio errors', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => json(429, { code: 60203 })));
      await expect(new SmsVerifyService().send(PHONE)).rejects.toMatchObject({ status: 429, code: 'TOO_MANY_CODES' });
      vi.stubGlobal('fetch', vi.fn(async () => json(400, { code: 60200 })));
      await expect(new SmsVerifyService().send(PHONE)).rejects.toMatchObject({ status: 400, code: 'INVALID_PHONE' });
      vi.stubGlobal('fetch', vi.fn(async () => json(500, {})));
      await expect(new SmsVerifyService().send(PHONE)).rejects.toMatchObject({ status: 502, code: 'SMS_PROVIDER_ERROR' });
    });

    it('checks codes: approved, wrong, or no longer pending', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => json(200, { status: 'approved' })));
      expect(await new SmsVerifyService().check(PHONE, '123456')).toBe(true);
      vi.stubGlobal('fetch', vi.fn(async () => json(200, { status: 'pending' })));
      expect(await new SmsVerifyService().check(PHONE, '000000')).toBe(false);
      vi.stubGlobal('fetch', vi.fn(async () => json(404, { code: 20404 })));
      expect(await new SmsVerifyService().check(PHONE, '123456')).toBe(false);
    });
  });

  describe('live test customer', () => {
    const LIVE_CODE = '87654321';
    const OTHER_PHONE = '+8801711000001';

    beforeEach(() => {
      Object.assign(env, twilio, { NODE_ENV: 'production', LIVE_TEST_PHONE: PHONE, LIVE_TEST_OTP: LIVE_CODE });
      delete env.TEST_OTP_CODE;
    });

    it('sends no SMS and accepts only the configured code for that number in production', async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const service = new SmsVerifyService();
      const warn = vi.spyOn((service as unknown as { logger: { warn: (msg: string) => void } }).logger, 'warn');
      await service.send(PHONE);
      expect(await service.check(PHONE, LIVE_CODE)).toBe(true);
      expect(await service.check(PHONE, '00000000')).toBe(false);
      expect(await service.check(PHONE, '123')).toBe(false);
      expect(await service.check(PHONE, 'éééééééé')).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps normal SMS verification for every other number, even with the live test code', async () => {
      const fetch = vi.fn(async () => json(200, { status: 'pending' }));
      vi.stubGlobal('fetch', fetch);
      const service = new SmsVerifyService();
      await service.send(OTHER_PHONE);
      expect(await service.check(OTHER_PHONE, LIVE_CODE)).toBe(false);
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/Verifications'), expect.objectContaining({
        body: expect.any(URLSearchParams),
      }));
      const args = fetch.mock.calls[1] as unknown as [string, RequestInit];
      expect(String(args[1].body)).toBe(`To=%2B8801711000001&Code=${LIVE_CODE}`);
      fetch.mockImplementation(async () => json(200, { status: 'approved' }));
      expect(await service.check(OTHER_PHONE, '654321')).toBe(true);
    });

    it('works without Twilio only for the configured test number in production', async () => {
      for (const key of Object.keys(twilio)) delete (env as Record<string, unknown>)[key];
      const service = new SmsVerifyService();
      await expect(service.send(PHONE)).resolves.toBeUndefined();
      expect(await service.check(PHONE, LIVE_CODE)).toBe(true);
      await expect(service.send(OTHER_PHONE)).rejects.toMatchObject({ status: 502, code: 'SMS_PROVIDER_ERROR' });
      expect(await service.check(OTHER_PHONE, LIVE_CODE)).toBe(false);
    });

    it('stops accepting the fixed code after the pair is removed', async () => {
      delete env.LIVE_TEST_PHONE;
      delete env.LIVE_TEST_OTP;
      vi.stubGlobal('fetch', vi.fn(async () => json(200, { status: 'pending' })));
      expect(await new SmsVerifyService().check(PHONE, LIVE_CODE)).toBe(false);
    });
  });
});
