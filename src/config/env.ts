import { existsSync } from 'node:fs';
import { z } from 'zod';

// Load `.env` in development and `.env.test` under Vitest (which sets NODE_ENV=test).
// In production the platform provides env vars. Variables already set win over the file.
const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
if (existsSync(envFile)) process.loadEnvFile(envFile);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  /** Comma-separated list of origins allowed to call the API from a browser. */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// connection string'),
  /** Signs the admin_token JWT. Generate with `openssl rand -base64 48`. */
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  /** How long a dashboard login lasts (JWT and cookie). */
  JWT_TTL_HOURS: z.coerce.number().int().positive().max(720).default(8),
  /** Folder for uploaded files (ground photos), served at /api/v1/uploads. */
  UPLOAD_DIR: z.string().min(1).default('uploads'),
  /** Proxies in front of the API (Render: 1). Rate limits then key on the client's IP, not the proxy's. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /** IANA timezone of the venue. Slot dates and hours, "today" and "already started" use it. */
  VENUE_TIMEZONE: z
    .string()
    .default('Asia/Dhaka')
    .refine(isTimeZone, 'must be an IANA timezone, e.g. Asia/Dhaka'),
  /** The customer site, for Stripe return URLs and links in emails. */
  PUBLIC_APP_URL: z.url().default('http://localhost:3000').transform((url) => url.replace(/\/$/, '')),
  /** ISO 4217, lowercase as Stripe uses it. Prices are in its smallest unit. */
  CURRENCY: z.string().regex(/^[a-z]{3}$/, 'must be a lowercase ISO 4217 code').default('bdt'),
  /** Portal card payments. Without it, POST /checkout returns 502 PAYMENT_PROVIDER_ERROR. */
  STRIPE_SECRET_KEY: z.string().startsWith('sk_', 'must be a Stripe secret key (sk_…)').optional(),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_', 'must be a Stripe webhook secret (whsec_…)').optional(),
  /** Without it, emails are skipped (logged, not sent). */
  SENDGRID_API_KEY: z.string().optional(),
  EMAIL_FROM: z.email().default('bookings@example.com'),
  /** Customer sign-in codes (Twilio Verify). Without them, codes are only logged, and only outside production. */
  TWILIO_ACCOUNT_SID: z.string().startsWith('AC', 'must be a Twilio account SID (AC…)').optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_VERIFY_SERVICE_SID: z.string().startsWith('VA', 'must be a Twilio Verify service SID (VA…)').optional(),
  /** Testing only: every sign-in code is this and no SMS is sent. Refused in production. */
  TEST_OTP_CODE: z.string().regex(/^\d{4,10}$/, 'must be 4–10 digits').optional(),
  /** How long a customer stays signed in (customer_token). */
  CUSTOMER_SESSION_DAYS: z.coerce.number().int().positive().max(365).default(30),
}).refine((e) => !(e.NODE_ENV === 'production' && e.TEST_OTP_CODE), {
  path: ['TEST_OTP_CODE'], message: 'must not be set in production',
});

function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment variables:\n${problems}`);
  }
  return parsed.data;
}

export const env = loadEnv();
