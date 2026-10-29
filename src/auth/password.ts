import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string, salt: Buffer, keyLength: number, options: ScryptOptions,
) => Promise<Buffer>;

// OWASP-recommended scrypt cost (N=2^16, r=8, p=2). Stored with each hash so it can be raised later.
const COST = { N: 2 ** 16, r: 8, p: 2 };
const KEY_LENGTH = 64;
const maxmem = (N: number, r: number) => 256 * N * r; // 2× what scrypt needs

/** Hashes a password as `scrypt$N$r$p$salt$hash` (salt and hash base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, { ...COST, maxmem: maxmem(COST.N, COST.r) });
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

/** Constant-time check of a password against a stored hash. Malformed hashes never match. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;

  const N = Number(n), R = Number(r), P = Number(p);
  if (![N, R, P].every(Number.isInteger)) return false;

  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N, r: R, p: P, maxmem: maxmem(N, R),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
