import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { env } from '../../src/config/env.js';

/** Run before any proof migration, role creation or schema cleanup. */
export function requireProofDatabase() {
  assert.equal(env.NODE_ENV, 'test');
  const target = new URL(env.DATABASE_URL);
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname),
    'Tenant proof requires a local test database',
  );
  assert(
    /test/i.test(target.pathname),
    'Database name must identify a test database',
  );
  if (existsSync('.env')) {
    const appFile = parseEnv(readFileSync('.env', 'utf8'));
    assert(
      appFile.DATABASE_URL,
      'Application DATABASE_URL must be set when .env exists',
    );
    const app = new URL(appFile.DATABASE_URL);
    assert.notEqual(
      target.host + target.pathname,
      app.host + app.pathname,
      'Test DB must differ from app DB',
    );
  }
}
