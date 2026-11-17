import { createHmac } from 'node:crypto';
import type { CookieOptions } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';

export const PLATFORM_COOKIE = 'platform_token';
export const PLATFORM_AUDIENCE = 'turf-platform';
export const PLATFORM_ISSUER = 'turf-platform-auth';
// Separate key material prevents a renamed platform cookie becoming a legacy staff token.
export const platformJwtSecret = createHmac('sha256', env.JWT_SECRET)
  .update('turf:platform-session:v1')
  .digest('hex');
export const PlatformSessionSchema = z.object({
  sub: z.uuid(),
  gid: z.uuid(),
  ver: z.number().int().nonnegative(),
  uv: z.number().int().nonnegative(),
});
export type PlatformSession = z.infer<typeof PlatformSessionSchema>;
export interface PlatformUser {
  id: string;
  name: string;
  email: string;
  role: 'platform_admin';
}
export const platformCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
});

export interface PlatformActor {
  readonly userId: string;
  readonly grantId: string;
  readonly grantVersion: number;
  readonly userVersion: number;
}
