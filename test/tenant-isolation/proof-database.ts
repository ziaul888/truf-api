import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../../src/config/env.js';
import { PrismaClient as AdminClient } from '../../src/generated/prisma/client.js';
import {
  PrismaClient as ProofClient,
  type Prisma,
} from './generated/client.js';

const models = ['Ground', 'Slot', 'Booking', 'BookingSlot'] as const;

import { requireProofDatabase } from './test-database-safety.js';

export class ProofDatabase {
  readonly admin: AdminClient;
  readonly fixture: ProofClient;
  runtime!: ProofClient;
  parallel!: ProofClient;
  readonly role = `turf_tenant_proof_${randomBytes(8).toString('hex')}`;
  private locked = false;
  private roleCreated = false;

  constructor() {
    requireProofDatabase();
    this.admin = new AdminClient({
      adapter: new PrismaPg({ connectionString: env.DATABASE_URL, max: 1 }),
    });
    this.fixture = new ProofClient({
      adapter: new PrismaPg({ connectionString: env.DATABASE_URL, max: 1 }),
    });
  }

  async setup() {
    const [lock] = await this.admin.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_lock(hashtext('turf:tenant-isolation-proof')) AS locked
    `;
    assert(
      lock?.locked,
      'Another tenant proof is already using this test database',
    );
    this.locked = true;
    const [db] = await this.admin.$queryRaw<
      Array<{ name: string }>
    >`SELECT current_database() AS name`;
    assert.equal(
      db.name,
      decodeURIComponent(new URL(env.DATABASE_URL).pathname.slice(1)),
    );
    await this.admin.$executeRawUnsafe(
      'DROP SCHEMA IF EXISTS tenant_isolation_proof CASCADE',
    );
    await this.cleanFixtureIdentities();
    const ddl = readFileSync(new URL('./proof.sql', import.meta.url), 'utf8');
    for (const statement of ddl.split('\n-- statement\n'))
      await this.admin.$executeRawUnsafe(statement);
    await this.enablePolicies();
    await this.createRuntime();
  }

  private async enablePolicies() {
    for (const model of models) {
      const table = `tenant_isolation_proof."${model}"`;
      await this.admin.$executeRawUnsafe(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
      );
      await this.admin.$executeRawUnsafe(
        `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
      );
      await this.admin.$executeRawUnsafe(`
        CREATE POLICY tenant_boundary ON ${table}
        USING (tenant_isolation_proof.can_access("tenantId"))
        WITH CHECK (tenant_isolation_proof.can_access("tenantId"))
      `);
    }
  }

  private async createRuntime() {
    const password = randomBytes(32).toString('hex');
    await this.admin.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT set_config('app.proof_role', ${this.role}, true),
               set_config('app.proof_password', ${password}, true)
      `;
      await tx.$executeRawUnsafe(`
        DO $$ DECLARE r TEXT := current_setting('app.proof_role'); BEGIN
          EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', r, current_setting('app.proof_password'));
          EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), r);
          EXECUTE format('GRANT USAGE ON SCHEMA public, tenant_isolation_proof TO %I', r);
          EXECUTE format('GRANT SELECT (id, status) ON public."Tenant" TO %I', r);
          EXECUTE format('GRANT SELECT (id, "isActive") ON public."User" TO %I', r);
          EXECUTE format('GRANT SELECT (id, "tenantId", "userId", role, "isActive") ON public."TenantMembership" TO %I', r);
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tenant_isolation_proof TO %I', r);
          EXECUTE format('GRANT EXECUTE ON FUNCTION tenant_isolation_proof.can_access(TEXT) TO %I', r);
        END $$
      `);
    });
    this.roleCreated = true;
    const url = new URL(env.DATABASE_URL);
    url.username = this.role;
    url.password = password;
    // One connection makes reuse after success/failure deterministic.
    this.runtime = new ProofClient({
      adapter: new PrismaPg({ connectionString: url.toString(), max: 1 }),
    });
    this.parallel = new ProofClient({
      adapter: new PrismaPg({ connectionString: url.toString(), max: 4 }),
    });
  }

  run<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    concurrent = false,
  ): Promise<T> {
    return (concurrent ? this.parallel : this.runtime).$transaction(operation, {
      maxWait: 15_000,
      timeout: 10_000,
    });
  }

  async dispose() {
    await this.runtime?.$disconnect();
    await this.parallel?.$disconnect();
    await this.fixture.$disconnect();
    try {
      if (!this.locked) return;
      await this.admin.$executeRawUnsafe(
        'DROP SCHEMA IF EXISTS tenant_isolation_proof CASCADE',
      );
      await this.cleanFixtureIdentities();
      if (this.roleCreated) await this.dropRuntimeRole();
    } finally {
      // Disconnect releases the session-level test-harness advisory lock.
      await this.admin.$disconnect();
    }
  }

  private async cleanFixtureIdentities() {
    await this.admin.tenantMembership.deleteMany({
      where: { tenant: { slug: { startsWith: 'tenant-proof-' } } },
    });
    await this.admin.tenant.deleteMany({
      where: { slug: { startsWith: 'tenant-proof-' } },
    });
    await this.admin.user.deleteMany({
      where: { email: { endsWith: '@tenant-proof.test' } },
    });
  }

  private async dropRuntimeRole() {
    await this.admin.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.proof_role', ${this.role}, true)`;
      await tx.$executeRawUnsafe(`
        DO $$ BEGIN
          EXECUTE format('DROP OWNED BY %I', current_setting('app.proof_role'));
          EXECUTE format('DROP ROLE %I', current_setting('app.proof_role'));
        END $$
      `);
    });
  }
}
