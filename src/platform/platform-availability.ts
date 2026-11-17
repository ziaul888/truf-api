import { Prisma } from '../generated/prisma/client.js';
import { AppError } from '../common/app-error.js';

export async function withPlatformAvailability<T>(
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2021' || error.code === 'P2022')
    )
      throw new AppError(
        'Platform administration is being set up',
        503,
        'PLATFORM_NOT_READY',
      );
    throw error;
  }
}
