import type { CookieOptions } from 'express';
import { env } from '../config/env.js';

/** Separate from the staff `admin_token`: a customer session never grants dashboard access. */
export const CUSTOMER_COOKIE = 'customer_token';

const baseOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
});

export const customerCookieOptions = (): CookieOptions => ({
  ...baseOptions(),
  maxAge: env.CUSTOMER_SESSION_DAYS * 24 * 60 * 60 * 1000,
});

export const clearCustomerCookieOptions = baseOptions;
