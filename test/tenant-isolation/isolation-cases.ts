import { randomUUID } from 'node:crypto';
import {
  inTenantTransaction,
  type TenantTransactionRunner,
} from '../../src/tenants/tenant-transaction.js';
import { resolveTenantAccess } from '../../src/tenants/tenant-access.js';
import type { Prisma as AdminPrisma } from '../../src/generated/prisma/client.js';
import type { GetProof } from './proof-state.js';

export function isolationCases(get: GetProof) {
  describe('restricted database role and tenant boundaries', () => {
    it('uses a real non-owner login with no administrative or RLS bypass privileges', async () => {
      const { db } = get();
      const [role] = await db.runtime.$queryRaw<
        Array<{ name: string; unsafe: boolean }>
      >`
        SELECT current_user::TEXT AS name, (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb) AS unsafe
        FROM pg_roles WHERE rolname = current_user
      `;
      expect(role).toEqual({ name: db.role, unsafe: false });
      const [owner] = await db.runtime.$queryRaw<Array<{ owns: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_tables WHERE schemaname = 'tenant_isolation_proof' AND tableowner = current_user
        ) AS owns
      `;
      expect(owner.owns).toBe(false);
    });

    it('rejects an administrative connection before business work can run', async () => {
      const {
        db,
        fixtures: { a },
      } = get();
      const runner: TenantTransactionRunner<AdminPrisma.TransactionClient> = (
        work,
      ) => db.admin.$transaction(work);
      const work = vi.fn(async () => true);
      await expect(
        inTenantTransaction(
          runner,
          (tx) =>
            resolveTenantAccess(tx.tenantMembership, a.userId, a.tenantId),
          work,
        ),
      ).rejects.toMatchObject({ code: 'TENANT_DATABASE_ROLE_UNSAFE' });
      expect(work).not.toHaveBeenCalled();
    });

    it('denies unscoped reads and writes', async () => {
      const {
        db,
        fixtures: { a },
      } = get();
      expect(await db.runtime.ground.findMany()).toEqual([]);
      await expect(
        db.runtime.ground.create({
          data: { tenantId: a.tenantId, name: 'Unscoped write' },
        }),
      ).rejects.toThrow();
    });

    it('isolates reads, counts, updates and deletes even without tenant predicates', async () => {
      const {
        operations,
        fixtures: { a, b },
      } = get();
      await operations.run(a.userId, a.tenantId, async (tx) => {
        const rows = await tx.ground.findMany();
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.tenantId === a.tenantId)).toBe(true);
        expect(await tx.ground.count()).toBe(rows.length);
        expect(
          await tx.ground.findUnique({ where: { id: b.groundId } }),
        ).toBeNull();
        expect(
          (
            await tx.ground.updateMany({
              where: { id: b.groundId },
              data: { name: 'Forbidden' },
            })
          ).count,
        ).toBe(0);
        expect(
          (await tx.ground.deleteMany({ where: { id: b.groundId } })).count,
        ).toBe(0);
      });
    });

    it('prevents inserting or moving a row into another tenant', async () => {
      const {
        operations,
        fixtures: { a, b },
      } = get();
      await expect(
        operations.run(a.userId, a.tenantId, (tx) =>
          tx.ground.create({
            data: { tenantId: b.tenantId, name: 'Forbidden' },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        operations.run(a.userId, a.tenantId, (tx) =>
          tx.ground.update({
            where: { id: a.groundId },
            data: { tenantId: b.tenantId },
          }),
        ),
      ).rejects.toThrow();
    });

    it('rejects mismatched tenant relationships at the database boundary', async () => {
      const {
        operations,
        fixtures: { a, b },
      } = get();
      await expect(
        operations.run(a.userId, a.tenantId, (tx) =>
          tx.slot.create({
            data: {
              id: randomUUID(),
              tenantId: a.tenantId,
              groundId: b.groundId,
              date: new Date('2099-12-01'),
              startHour: 8,
              price: 1,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('applies the same policy to nested Prisma writes', async () => {
      const {
        operations,
        fixtures: { a },
      } = get();
      const row = await operations.run(a.userId, a.tenantId, (tx) =>
        tx.ground.create({
          data: {
            tenantId: a.tenantId,
            name: 'Nested write',
            slots: {
              create: { date: new Date('2099-12-02'), startHour: 8, price: 1 },
            },
          },
          include: { slots: true },
        }),
      );
      expect(row.slots).toEqual([
        expect.objectContaining({ tenantId: a.tenantId, groundId: row.id }),
      ]);
    });

    it('does not accept a forged tenant context for a user without membership', async () => {
      const {
        db,
        fixtures: { a, b },
      } = get();
      const rows = await db.run(async (tx) => {
        await tx.$executeRaw`
          SELECT set_config('app.tenant_id', ${b.tenantId}, true), set_config('app.user_id', ${a.userId}, true)
        `;
        return tx.ground.findMany();
      });
      expect(rows).toEqual([]);
    });
  });
}
