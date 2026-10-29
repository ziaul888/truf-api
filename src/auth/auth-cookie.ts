import type { CookieOptions } from 'express';
import { env } from '../config/env.js';

export const AUTH_COOKIE = 'admin_token';

const baseOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
});

/** Cookie lifetime matches the JWT's, so both expire together. */
export const authCookieOptions = (): CookieOptions => ({
  ...baseOptions(),
  maxAge: env.JWT_TTL_HOURS * 60 * 60 * 1000,
});

/** `clearCookie` only works when the options match the ones the cookie was set with. */
export const clearAuthCookieOptions = baseOptions;
