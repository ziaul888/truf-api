vi.mock('node:fs', () => ({ existsSync: () => false }));

const PHONE = '+8801799009901';
const CODE = '87654321';

async function load(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  const values = {
    NODE_ENV: 'production', DATABASE_URL: 'postgresql://unit:unit@localhost/turf_test', JWT_SECRET: 'unit-secret-that-is-at-least-32-characters',
    TEST_OTP_CODE: undefined, LIVE_TEST_PHONE: undefined, LIVE_TEST_OTP: undefined, ...overrides,
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
  return import('./env.js');
}

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('live test login environment', () => {
  it('is disabled by default in production', async () => {
    const { env } = await load();
    expect(env.LIVE_TEST_PHONE).toBeUndefined();
    expect(env.LIVE_TEST_OTP).toBeUndefined();
  });

  it('allows the explicit phone and code pair in production', async () => {
    const { env } = await load({ LIVE_TEST_PHONE: PHONE, LIVE_TEST_OTP: CODE });
    expect(env).toMatchObject({ NODE_ENV: 'production', LIVE_TEST_PHONE: PHONE, LIVE_TEST_OTP: CODE });
  });

  it.each([
    { LIVE_TEST_PHONE: PHONE }, { LIVE_TEST_OTP: CODE },
  ])('rejects an incomplete pair: %o', async (overrides) => {
    await expect(load(overrides)).rejects.toThrow('LIVE_TEST_PHONE and LIVE_TEST_OTP must be set together');
  });

  it.each(['01799009901', '+00000000', 'not-a-phone'])('rejects a noncanonical phone: %s', async (phone) => {
    await expect(load({ LIVE_TEST_PHONE: phone, LIVE_TEST_OTP: CODE })).rejects.toThrow('must be an E.164 phone number');
  });

  it.each(['13456', '1234567', '12345678901', 'abcdefgh'])('rejects a short or invalid code: %s', async (code) => {
    await expect(load({ LIVE_TEST_PHONE: PHONE, LIVE_TEST_OTP: code })).rejects.toThrow('must be 8–10 digits');
  });

  it('continues to reject global TEST_OTP_CODE in production', async () => {
    await expect(load({ TEST_OTP_CODE: '13456', LIVE_TEST_PHONE: PHONE, LIVE_TEST_OTP: CODE })).rejects.toThrow('must not be set in production');
  });
});
