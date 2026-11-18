import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { AppError } from '../common/app-error.js';
import { hashPassword } from '../auth/password.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { applicationFingerprint } from './owner-application-fingerprint.js';
import {
  ownerApplicationSelect,
  toOwnerApplicationDto,
} from './owner-application.dto.js';
import type { SubmitOwnerApplication } from './owner-applications.schemas.js';
import {
  platformPlanSelect,
  toPlanDto,
} from '../platform/platform-billing.dto.js';

const unavailable = () =>
  new AppError(
    'An application with these details is already pending',
    409,
    'APPLICATION_ALREADY_PENDING',
  );

@Injectable()
export class OwnerApplicationsService {
  constructor(private readonly db: PrismaService) {}

  async submit(input: SubmitOwnerApplication) {
    const inputHash = applicationFingerprint(input);
    const passwordHash = await hashPassword(input.password);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.create(input, inputHash, passwordHash);
      } catch (error) {
        const retry =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034' &&
          attempt < 3;
        if (retry) continue;
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        )
          throw unavailable();
        throw error;
      }
    }
  }

  async plans() {
    const rows = await this.db.platformPlan.findMany({
      where: { isActive: true },
      select: platformPlanSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 100,
    });
    return rows.map(toPlanDto);
  }

  private create(
    input: SubmitOwnerApplication,
    inputHash: string,
    passwordHash: string,
  ) {
    return this.db.$transaction(
      async (tx) => {
        const replay = await tx.ownerApplication.findUnique({
          where: { requestId: input.requestId },
          select: { ...ownerApplicationSelect, inputHash: true },
        });
        if (replay) {
          if (replay.inputHash !== inputHash) throw unavailable();
          return toOwnerApplicationDto(replay);
        }
        await this.assertAvailable(tx, input.ownerEmail, input.slug);
        const planVersionId = await this.availablePlanVersion(tx, input.planId);
        const created = await tx.ownerApplication.create({
          data: {
            requestId: input.requestId,
            inputHash,
            turfName: input.name,
            slug: input.slug,
            ownerName: input.ownerName,
            ownerEmail: input.ownerEmail,
            passwordHash,
            timezone: input.timezone,
            currency: input.currency,
            planVersionId,
            billingInterval: input.interval,
          },
          select: ownerApplicationSelect,
        });
        return toOwnerApplicationDto(created);
      },
      { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 10_000 },
    );
  }

  private async availablePlanVersion(
    tx: Prisma.TransactionClient,
    planId: string,
  ) {
    const version = await tx.platformPlanVersion.findFirst({
      where: { planId, plan: { isActive: true } },
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    if (!version)
      throw new AppError(
        'Choose an available subscription plan',
        400,
        'PLAN_NOT_AVAILABLE',
      );
    return version.id;
  }

  private async assertAvailable(
    tx: Prisma.TransactionClient,
    email: string,
    slug: string,
  ) {
    const [user, tenant, pending] = await Promise.all([
      tx.user.findUnique({ where: { email }, select: { id: true } }),
      tx.tenant.findUnique({ where: { slug }, select: { id: true } }),
      tx.ownerApplication.findFirst({
        where: {
          status: 'pending',
          OR: [{ ownerEmail: email }, { slug }],
        },
        select: { id: true },
      }),
    ]);
    if (user || tenant || pending) throw unavailable();
  }
}
