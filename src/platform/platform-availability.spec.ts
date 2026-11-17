import { Prisma } from '../generated/prisma/client.js';
import { withPlatformAvailability } from './platform-availability.js';
describe('platform setup availability', () => {
  it.each(['P2021', 'P2022'])(
    'returns a safe setup state for %s',
    async (code) => {
      await expect(
        withPlatformAvailability(async () => {
          throw new Prisma.PrismaClientKnownRequestError('schema not ready', {
            code,
            clientVersion: 'test',
          });
        }),
      ).rejects.toMatchObject({ status: 503, code: 'PLATFORM_NOT_READY' });
    },
  );
  it('does not hide an unrelated failure', async () => {
    const error = new Error('unrelated');
    await expect(
      withPlatformAvailability(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});
