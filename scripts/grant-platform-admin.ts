import { z } from 'zod';
import { env } from '../src/config/env.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

function bootstrapEmail() {
  const index = process.argv.indexOf('--email');
  const email = z
    .email()
    .parse(index < 0 ? undefined : process.argv[index + 1])
    .trim()
    .toLowerCase();
  const host = new URL(env.DATABASE_URL).hostname;
  if (
    env.NODE_ENV !== 'development' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(host)
  )
    throw new Error(
      'This bootstrap command supports only the local development database',
    );
  return email;
}

async function grant() {
  const email = bootstrapEmail();
  const db = new PrismaService();
  try {
    const user = await db.user.findUnique({
      where: { email },
      select: { id: true, isActive: true },
    });
    if (!user?.isActive)
      throw new Error('An existing active staff identity is required');
    await db.platformGrant.upsert({
      where: { userId: user.id },
      create: { userId: user.id },
      update: { isActive: true, tokenVersion: { increment: 1 } },
    });
    console.log(
      `Platform administrator access enabled for ${email} in the local development database.`,
    );
  } finally {
    await db.$disconnect();
  }
}
await grant();
