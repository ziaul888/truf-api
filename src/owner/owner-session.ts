import { createHmac } from 'node:crypto';
import type { CookieOptions, Request } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
export const OWNER_COOKIE = 'owner_token';
export const OWNER_AUDIENCE = 'turf-owner';
export const OWNER_ISSUER = 'turf-owner-auth';
export const ownerSecret = createHmac('sha256', env.JWT_SECRET)
  .update('turf:owner-session:v1')
  .digest('hex');
export const OwnerSessionSchema = z.object({
  sub: z.uuid(),
  tid: z.uuid(),
  mid: z.uuid(),
  uv: z.number().int().nonnegative(),
  mv: z.number().int().nonnegative(),
});
export type OwnerSession = z.infer<typeof OwnerSessionSchema>;
export interface OwnerUser {
  id: string;
  email: string;
  name: string;
  role: 'owner';
  audience: 'owner';
  tenant: {
    id: string;
    slug: string;
    name: string;
    status: string;
    timezone: string;
    currency: string;
    setupComplete: boolean;
  };
}
export interface OwnerContext {
  session: Readonly<OwnerSession>;
  user: OwnerUser;
}
export type OwnerRequest = Request & { owner?: OwnerContext };
export const ownerCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
});
