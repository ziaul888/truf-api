import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // e2e files run in parallel against one database, with several password hashes per test.
    testTimeout: 15_000,
    // Stripe is mocked, but card checkout is only offered with keys set. Never real keys.
    // TEST_OTP_CODE: customers sign in with this code and no SMS is sent (test/sign-in-customer.ts).
    env: { STRIPE_SECRET_KEY: 'sk_test_e2e', STRIPE_WEBHOOK_SECRET: 'whsec_e2e', TEST_OTP_CODE: '123456' },
  },
});
