import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma CLI config. Mirrors src/config/env.ts: `.env.test` when NODE_ENV=test, else `.env`.
// Variables already set in the shell win over the file.
const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  datasource: { url: process.env.DATABASE_URL },
});
