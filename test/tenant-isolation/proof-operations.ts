import { AppError } from '../../src/common/app-error.js';
import {
  resolveTenantAccess,
  type TenantContext,
} from '../../src/tenants/tenant-access.js';
import {
  inTenantTransaction,
  type TenantTransactionRunner,
} from '../../src/tenants/tenant-transaction.js';
import type { TenantMembershipRole } from '../../src/generated/prisma/client.js';
import type { Prisma } from './generated/client.js';
import type { ProofDatabase } from './proof-database.js';

const unavailable = () =>
  new AppError('Those slots are unavailable', 409, 'SLOT_NOT_AVAILABLE');

/** Reservation projection only: the production booking service remains unchanged. */
export class ProofOperations {
  constructor(private readonly db: ProofDatabase) {}

  run<T>(
    userId: string,
    tenantId: string,
    operation: (
      tx: Prisma.TransactionClient,
      scope: TenantContext,
    ) => Promise<T>,
    roles: readonly TenantMembershipRole[] = [],
    concurrent = false,
  ): Promise<T> {
    const runner: TenantTransactionRunner<Prisma.TransactionClient> = (work) =>
      this.db.run(work, concurrent);
    return inTenantTransaction(
      runner,
      (tx) => resolveTenantAccess(tx.tenantMembership, userId, tenantId, roles),
      operation,
    );
  }

  reserve(
    userId: string,
    tenantId: string,
    ids: string[],
    beforeClaim?: () => Promise<void>,
  ) {
    return this.run(
      userId,
      tenantId,
      async (tx, scope) => {
        const slots = await tx.slot.findMany({
          where: { id: { in: ids } },
          orderBy: [{ date: 'asc' }, { startHour: 'asc' }],
        });
        if (!slots.length || slots.length !== new Set(ids).size)
          throw unavailable();
        const first = slots[0];
        if (
          slots.some(
            (s) =>
              s.groundId !== first.groundId ||
              s.date.getTime() !== first.date.getTime(),
          )
        )
          throw unavailable();
        await beforeClaim?.();
        const claimed = await tx.slot.updateMany({
          where: { id: { in: ids }, status: 'available' },
          data: { status: 'booked' },
        });
        if (claimed.count !== ids.length) throw unavailable();
        const booking = await tx.booking.create({
          data: {
            tenantId: scope.tenantId,
            groundId: first.groundId,
            slotId: first.id,
            liveSlotId: first.id,
          },
        });
        await tx.bookingSlot.createMany({
          data: slots.map((slot) => ({
            tenantId: scope.tenantId,
            bookingId: booking.id,
            slotId: slot.id,
            liveSlotId: slot.id,
            price: slot.price,
          })),
        });
        return tx.booking.findUniqueOrThrow({
          where: { id: booking.id },
          include: { bookingSlots: true },
        });
      },
      [],
      true,
    );
  }
}
