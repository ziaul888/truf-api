import { AppError } from '../common/app-error.js';
import type { PlatformTx } from './platform-command.js';
import { billingDate, billingToday } from './platform-billing-dates.js';
import { createPlatformInvoice } from './platform-invoice-builder.js';

async function pendingApplication(tx: PlatformTx, applicationId: string) {
  const application = await tx.ownerApplication.findUnique({
    where: { id: applicationId },
    include: {
      planVersion: { include: { plan: { select: { name: true } } } },
    },
  });
  if (!application)
    throw new AppError('Application not found', 404, 'APPLICATION_NOT_FOUND');
  const passwordHash = application.passwordHash;
  if (application.status !== 'pending' || !passwordHash)
    throw new AppError(
      'This application has already been reviewed',
      409,
      'APPLICATION_ALREADY_REVIEWED',
    );
  const planVersion = application.planVersion;
  const billingInterval = application.billingInterval;
  if (!planVersion || !billingInterval)
    throw new AppError(
      'This application does not have an available subscription plan',
      409,
      'PLAN_NOT_AVAILABLE',
    );
  return { ...application, passwordHash, planVersion, billingInterval };
}

async function createInitialSubscription(
  tx: PlatformTx,
  application: Awaited<ReturnType<typeof pendingApplication>>,
  tenantId: string,
) {
  const version = application.planVersion;
  const interval = application.billingInterval;
  const anchorDate = billingToday();
  const subscription = await tx.platformSubscription.create({
    data: {
      tenantId,
      planVersionId: version.id,
      planName: version.plan.name,
      interval,
      currency: version.currency,
      amount:
        interval === 'monthly' ? version.monthlyAmount : version.yearlyAmount,
      anchorDate,
    },
  });
  const invoice = await createPlatformInvoice(
    tx,
    subscription,
    0,
    billingDate(anchorDate),
  );
  return { subscription, invoice };
}

function createOwner(
  tx: PlatformTx,
  application: Awaited<ReturnType<typeof pendingApplication>>,
) {
  return tx.user.create({
    data: {
      email: application.ownerEmail,
      name: application.ownerName,
      passwordHash: application.passwordHash,
      role: 'manager',
      isActive: true,
      legacyStaffAccess: false,
    },
  });
}

function createTurf(
  tx: PlatformTx,
  application: Awaited<ReturnType<typeof pendingApplication>>,
  userId: string,
) {
  return tx.tenant.create({
    data: {
      name: application.turfName,
      slug: application.slug,
      timezone: application.timezone,
      currency: application.currency,
      status: 'draft',
      memberships: { create: { userId, role: 'owner' } },
    },
  });
}

export async function activateApplication(
  tx: PlatformTx,
  applicationId: string,
  actorId: string,
) {
  const application = await pendingApplication(tx, applicationId);
  const user = await createOwner(tx, application);
  const tenant = await createTurf(tx, application, user.id);
  const billing = await createInitialSubscription(tx, application, tenant.id);
  await tx.ownerApplication.update({
    where: { id: application.id },
    data: {
      status: 'activated',
      reviewedAt: new Date(),
      reviewedById: actorId,
      tenantId: tenant.id,
      passwordHash: null,
    },
  });
  return {
    targetId: tenant.id,
    tenantId: tenant.id,
    details: {
      applicationId: application.id,
      status: 'activated',
      subscriptionId: billing.subscription.id,
      invoiceId: billing.invoice.id,
      planVersionId: billing.subscription.planVersionId,
      interval: billing.subscription.interval,
      amount: billing.subscription.amount,
    },
  };
}

export async function rejectApplication(
  tx: PlatformTx,
  applicationId: string,
  actorId: string,
) {
  const updated = await tx.ownerApplication.updateMany({
    where: { id: applicationId, status: 'pending' },
    data: {
      status: 'rejected',
      reviewedAt: new Date(),
      reviewedById: actorId,
      passwordHash: null,
    },
  });
  if (updated.count !== 1) {
    const exists = await tx.ownerApplication.findUnique({
      where: { id: applicationId },
      select: { id: true },
    });
    throw new AppError(
      exists
        ? 'This application has already been reviewed'
        : 'Application not found',
      exists ? 409 : 404,
      exists ? 'APPLICATION_ALREADY_REVIEWED' : 'APPLICATION_NOT_FOUND',
    );
  }
  return {
    targetId: applicationId,
    details: { applicationId, status: 'rejected' },
  };
}
