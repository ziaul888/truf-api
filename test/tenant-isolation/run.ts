import { execFileSync } from 'node:child_process';
import { requireProofDatabase } from './test-database-safety.js';

requireProofDatabase();
try {
  for (const command of [
    'db:generate',
    'db:generate:tenant-proof',
    'db:migrate:test',
  ]) {
    execFileSync('yarn', [command], { stdio: 'inherit' });
  }
  execFileSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'vitest.config.e2e.ts',
      'test/tenant-isolation.e2e-spec.ts',
      '--no-file-parallelism',
    ],
    { stdio: 'inherit' },
  );
} catch {
  process.exitCode = 1;
}
