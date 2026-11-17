import { AppError } from '../common/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { TenantContext } from './tenant-access.js';

type TenantSqlClient = Pick<
  Prisma.TransactionClient,
  '$executeRaw' | '$queryRaw'
>;
export type TenantTransactionRunner<Tx> = <T>(
  operation: (tx: Tx) => Promise<T>,
) => Promise<T>;

/** Reject connections that bypass ordinary RLS, including inherited table ownership. */
async function requireRestrictedRole(tx: TenantSqlClient): Promise<void> {
  const [role] = await tx.$queryRaw<Array<{ unsafe: boolean }>>`
    SELECT (
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls))
      OR EXISTS (
        SELECT 1 FROM pg_class
        WHERE relrowsecurity
          AND pg_has_role(current_user, relowner, 'USAGE')
      )
    ) AS unsafe
  `;
  if (!role || role.unsafe) {
    throw new AppError(
      'Tenant database access requires a restricted runtime role',
      500,
      'TENANT_DATABASE_ROLE_UNSAFE',
    );
  }
}

/**
 * One database unit of work, on one connection. Re-authorize inside the transaction.
 * set_config is the narrowly documented SQL exception; true means transaction-local.
 */
export async function inTenantTransaction<Tx extends TenantSqlClient, T>(
  run: TenantTransactionRunner<Tx>,
  authorize: (tx: Tx) => Promise<TenantContext>,
  operation: (tx: Tx, context: TenantContext) => Promise<T>,
): Promise<T> {
  return run(async (tx) => {
    await requireRestrictedRole(tx);
    const context = await authorize(tx);
    await tx.$executeRaw`
      SELECT set_config('app.tenant_id', ${context.tenantId}, true),
             set_config('app.user_id', ${context.userId}, true)
    `;
    return operation(tx, context);
  });
}
