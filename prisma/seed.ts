// Creates the first admin account. Run with `yarn db:seed`; safe to run again.
// Reads SEED_* directly: they're only for this script, so they stay out of the app's env schema.
import { z } from 'zod';
import { EmailSchema, NewPasswordSchema } from '../src/auth/auth.schemas.js';
import { hashPassword } from '../src/auth/password.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const SeedEnvSchema = z.object({
  SEED_ADMIN_EMAIL: EmailSchema,
  SEED_ADMIN_PASSWORD: NewPasswordSchema,
  SEED_ADMIN_NAME: z.string().trim().min(1).default('Admin'),
});

async function main() {
  const parsed = SeedEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Set these in .env before seeding:\n${problems}`);
  }
  const { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: password, SEED_ADMIN_NAME: name } = parsed.data;

  const prisma = new PrismaService();
  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      console.log(`Admin ${email} already exists — left unchanged.`);
      return;
    }
    await prisma.user.create({
      data: { email, name, role: 'admin', passwordHash: await hashPassword(password) },
    });
    console.log(`Created admin ${email}.`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
