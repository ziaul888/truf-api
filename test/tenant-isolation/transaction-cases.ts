import { AppError } from '../../src/common/app-error.js';
import type { GetProof } from './proof-state.js';
import { freshSlots } from './proof-fixtures.js';

/** Both transactions must read the free slots before either attempts to claim them. */
function raceBarrier() {
  let count = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    if (++count === 2) release();
    await ready;
  };
}

export function transactionCases(get: GetProof) {
  describe('connection reuse and reservation transactions', () => {
    it('clears context after commit and rollback on a reused connection', async () => {
      const {
        db,
        operations,
        fixtures: { a, b },
      } = get();
      const pids: number[] = [];
      const remember = async (business: typeof a, fail = false) =>
        operations.run(business.userId, business.tenantId, async (tx) => {
          const [row] = await tx.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          pids.push(row.pid);
          expect(
            (await tx.ground.findMany()).every(
              (ground) => ground.tenantId === business.tenantId,
            ),
          ).toBe(true);
          if (fail) throw new AppError('Rollback probe', 409, 'PROOF_ROLLBACK');
        });
      await remember(a);
      await expect(remember(a, true)).rejects.toMatchObject({
        code: 'PROOF_ROLLBACK',
      });
      await remember(b);
      expect(new Set(pids).size).toBe(1);
      const [context] = await db.runtime.$queryRaw<
        Array<{ tenant: string | null; actor: string | null }>
      >`
        SELECT NULLIF(current_setting('app.tenant_id', true), '') AS tenant,
               NULLIF(current_setting('app.user_id', true), '') AS actor
      `;
      expect(context).toEqual({ tenant: null, actor: null });
      expect(await db.runtime.ground.count()).toBe(0);
    });

    it('keeps concurrent requests isolated across pooled connections', async () => {
      const {
        operations,
        fixtures: { a, b },
      } = get();
      await Promise.all(
        Array.from({ length: 16 }, (_, index) => {
          const business = index % 2 ? a : b;
          return operations.run(
            business.userId,
            business.tenantId,
            async (tx) => {
              const rows = await tx.ground.findMany();
              expect(rows.length).toBeGreaterThan(0);
              expect(
                rows.every((row) => row.tenantId === business.tenantId),
              ).toBe(true);
            },
            [],
            true,
          );
        }),
      );
    });

    it.each([1, 2])(
      'allows only one competing reservation for %i slots',
      async (count) => {
        const {
          db,
          operations,
          fixtures: { a },
        } = get();
        const slots = await freshSlots(db, a, count);
        const ids = slots.map((slot) => slot.id);
        const barrier = raceBarrier();
        const results = await Promise.allSettled([
          operations.reserve(a.userId, a.tenantId, ids, barrier),
          operations.reserve(a.userId, a.tenantId, ids, barrier),
        ]);
        expect(
          results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        const failed = results.find((result) => result.status === 'rejected');
        expect(failed?.status === 'rejected' && failed.reason).toMatchObject({
          code: 'SLOT_NOT_AVAILABLE',
        });
        expect(
          await db.fixture.booking.count({ where: { slotId: ids[0] } }),
        ).toBe(1);
        expect(
          await db.fixture.bookingSlot.count({
            where: { slotId: { in: ids }, liveSlotId: { not: null } },
          }),
        ).toBe(count);
      },
    );

    it('rolls back every claim when a multi-slot selection contains an unavailable slot', async () => {
      const {
        db,
        operations,
        fixtures: { a },
      } = get();
      const slots = await freshSlots(db, a, 2);
      await db.fixture.slot.update({
        where: { id: slots[1].id },
        data: { status: 'booked' },
      });
      await expect(
        operations.reserve(
          a.userId,
          a.tenantId,
          slots.map((slot) => slot.id),
        ),
      ).rejects.toMatchObject({ code: 'SLOT_NOT_AVAILABLE' });
      expect(
        await db.fixture.slot.findUniqueOrThrow({ where: { id: slots[0].id } }),
      ).toMatchObject({ status: 'available' });
      expect(
        await db.fixture.booking.count({ where: { slotId: slots[0].id } }),
      ).toBe(0);
    });

    it('does not write partial state when the callback fails', async () => {
      const {
        operations,
        fixtures: { a },
      } = get();
      await expect(
        operations.run(a.userId, a.tenantId, async (tx) => {
          await tx.ground.create({
            data: { tenantId: a.tenantId, name: 'Rollback-only ground' },
          });
          throw new Error('Abort this operation');
        }),
      ).rejects.toThrow('Abort this operation');
      expect(
        await operations.run(a.userId, a.tenantId, (tx) =>
          tx.ground.count({ where: { name: 'Rollback-only ground' } }),
        ),
      ).toBe(0);
    });
  });
}
