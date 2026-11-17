import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AppError } from '../common/app-error.js';
export async function ownerTransaction<T>(
  db: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(work, {
        isolationLevel: 'Serializable',
        maxWait: 10000,
        timeout: 10000,
      });
    } catch (error) {
      const conflict =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2034'].includes(error.code);
      if (conflict && attempt < 3) continue;
      if (conflict)
        throw new AppError(
          'This account changed. Please try again.',
          409,
          'OWNER_CONFLICT',
        );
      throw error;
    }
  }
}
