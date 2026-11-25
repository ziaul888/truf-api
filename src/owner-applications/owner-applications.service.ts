import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { AppError } from '../common/app-error.js';
import { hashPassword } from '../auth/password.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toDbDate } from '../slots/venue-time.js';
import { billingToday } from '../platform/platform-billing-dates.js';
import { paymentInstructions } from '../platform/platform-payment-instructions.js';
import { applicationFingerprint } from './owner-application-fingerprint.js';
import {
  ownerApplicationSelect,
  toOwnerApplicationDto,
} from './owner-application.dto.js';
import type {
  ApplicationPayment,
  SubmitOwnerApplication,
} from './owner-applications.schemas.js';
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

  paymentMethods() {
    return paymentInstructions(this.db);
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
        const planVersionId = await this.availablePlanVersion(tx, input);
        const payment = input.paymentMethod
          ? {
              paymentMethod: input.paymentMethod,
              paymentReference: input.paymentReference,
              paymentDate: await assertPaymentProof(tx, input),
            }
          : {};
        const created = await tx.ownerApplication.create({
          data: {
            requestId: input.requestId,
            inputHash,
            turfName: input.name,
            slug: input.slug,
            logoDataUrl: input.logo,
            ownerName: input.ownerName,
            ownerEmail: input.ownerEmail,
            passwordHash,
            timezone: input.timezone,
            currency: input.currency,
            planVersionId,
            billingInterval: input.interval,
            ...payment,
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
    input: SubmitOwnerApplication,
  ) {
    const version = await tx.platformPlanVersion.findFirst({
      where: { planId: input.planId, plan: { isActive: true } },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        monthlyAmount: true,
        yearlyAmount: true,
        trialDays: true,
      },
    });
    if (!version)
      throw new AppError(
        'Choose an available subscription plan',
        400,
        'PLAN_NOT_AVAILABLE',
      );
    if (version.trialDays && input.paymentMethod) {
      throw new AppError(
        'The trial plan is free',
        400,
        'TRIAL_PAYMENT_NOT_REQUIRED',
      );
    }
    const amount =
      input.interval === 'monthly'
        ? version.monthlyAmount
        : version.yearlyAmount;
    if (
      version.version !== input.planVersion ||
      amount !== input.expectedAmount
    ) {
      throw new AppError(
        input.paymentMethod
          ? 'The plan price changed. Contact the platform administrator if you already paid.'
          : 'The plan price changed. Reload the page to review the current price.',
        409,
        'PLAN_PRICE_CHANGED',
      );
    }
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

async function assertPaymentProof(
  tx: Prisma.TransactionClient,
  input: ApplicationPayment,
) {
  const methods = await paymentInstructions(tx);
  if (!methods[input.paymentMethod]) {
    throw new AppError(
      'This payment method is not available',
      400,
      'PAYMENT_METHOD_UNAVAILABLE',
    );
  }
  const date = toDbDate(input.paymentDate);
  if (date > billingToday()) {
    throw new AppError(
      'Payment date cannot be in the future',
      400,
      'PAYMENT_DATE_IN_FUTURE',
    );
  }
  const recorded = await tx.platformReceipt.findUnique({
    where: {
      method_referenceNormalized: {
        method: input.paymentMethod,
        referenceNormalized: input.paymentReference,
      },
    },
    select: { id: true },
  });
  const pending = await tx.ownerApplication.findFirst({
    where: {
      status: 'pending',
      paymentMethod: input.paymentMethod,
      paymentReference: input.paymentReference,
    },
    select: { id: true },
  });
  if (recorded || pending)
    throw new AppError(
      'This payment reference has already been used',
      409,
      'PAYMENT_REFERENCE_USED',
    );
  return date;
}
