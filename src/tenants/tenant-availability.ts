import { AppError } from '../common/app-error.js';
import { Prisma } from '../generated/prisma/client.js';

/** A rolling deployment may reach these read-only routes before the foundation tables exist. */
export async function withTenantAvailability<T>(
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2021' || error.code === 'P2022')
    ) {
      throw new AppError(
        'Business accounts are not available yet',
        503,
        'TENANT_WORKSPACES_UNAVAILABLE',
      );
    }
    throw error;
  }
}
