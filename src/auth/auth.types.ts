import type { Request } from 'express';
import type { User, UserRole } from '../generated/prisma/client.js';

/** The signed-in staff member, safe to return to the client (no password hash). */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface JwtPayload {
  sub: string;
  role: UserRole;
  /** The user's `tokenVersion` when the token was issued; a mismatch means it was revoked. */
  ver: number;
}

export type AuthedRequest = Request & { user?: AuthUser };

export const toAuthUser = ({ id, email, name, role }: User): AuthUser => ({ id, email, name, role });
