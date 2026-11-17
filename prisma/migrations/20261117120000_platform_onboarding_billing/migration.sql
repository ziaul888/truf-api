-- CreateEnum
CREATE TYPE "PlatformBillingInterval" AS ENUM ('monthly', 'yearly');

-- CreateEnum
CREATE TYPE "PlatformSubscriptionState" AS ENUM ('pending', 'active', 'cancelled');

-- CreateEnum
CREATE TYPE "PlatformInvoiceState" AS ENUM ('issued', 'paid', 'void');

-- CreateEnum
CREATE TYPE "PlatformReceiptMethod" AS ENUM ('bkash', 'nagad', 'bank_transfer');

-- CreateEnum
CREATE TYPE "PlatformAuditAction" AS ENUM ('tenant_created', 'plan_created', 'subscription_created', 'invoice_issued', 'invoice_paid', 'subscription_cancelled');

-- CreateTable
CREATE TABLE "PlatformPlan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformPlanVersion" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'bdt',
    "monthlyAmount" INTEGER NOT NULL,
    "yearlyAmount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformPlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSubscription" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "planName" TEXT NOT NULL,
    "interval" "PlatformBillingInterval" NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "anchorDate" DATE NOT NULL,
    "paidThrough" DATE,
    "status" "PlatformSubscriptionState" NOT NULL DEFAULT 'pending',
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformInvoice" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "periodIndex" INTEGER NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "dueOn" DATE NOT NULL,
    "planName" TEXT NOT NULL,
    "interval" "PlatformBillingInterval" NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "PlatformInvoiceState" NOT NULL DEFAULT 'issued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformReceipt" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "method" "PlatformReceiptMethod" NOT NULL,
    "reference" TEXT NOT NULL,
    "referenceNormalized" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "receivedOn" DATE NOT NULL,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformAuditEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "tenantId" TEXT,
    "action" "PlatformAuditAction" NOT NULL,
    "targetId" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformPlan_code_key" ON "PlatformPlan"("code");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformPlanVersion_planId_version_key" ON "PlatformPlanVersion"("planId", "version");

-- CreateIndex
CREATE INDEX "PlatformSubscription_tenantId_status_idx" ON "PlatformSubscription"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformSubscription_id_tenantId_key" ON "PlatformSubscription"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformInvoice_number_key" ON "PlatformInvoice"("number");

-- CreateIndex
CREATE INDEX "PlatformInvoice_tenantId_createdAt_idx" ON "PlatformInvoice"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformInvoice_status_dueOn_idx" ON "PlatformInvoice"("status", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformInvoice_subscriptionId_periodIndex_key" ON "PlatformInvoice"("subscriptionId", "periodIndex");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformInvoice_id_tenantId_key" ON "PlatformInvoice"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformReceipt_invoiceId_key" ON "PlatformReceipt"("invoiceId");

-- CreateIndex
CREATE INDEX "PlatformReceipt_tenantId_receivedOn_idx" ON "PlatformReceipt"("tenantId", "receivedOn");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformReceipt_invoiceId_tenantId_key" ON "PlatformReceipt"("invoiceId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformReceipt_method_referenceNormalized_key" ON "PlatformReceipt"("method", "referenceNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAuditEvent_requestId_key" ON "PlatformAuditEvent"("requestId");

-- CreateIndex
CREATE INDEX "PlatformAuditEvent_tenantId_createdAt_idx" ON "PlatformAuditEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformAuditEvent_actorId_createdAt_idx" ON "PlatformAuditEvent"("actorId", "createdAt");

-- AddForeignKey
ALTER TABLE "PlatformPlanVersion" ADD CONSTRAINT "PlatformPlanVersion_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PlatformPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformSubscription" ADD CONSTRAINT "PlatformSubscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformSubscription" ADD CONSTRAINT "PlatformSubscription_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlatformPlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformInvoice" ADD CONSTRAINT "PlatformInvoice_subscriptionId_tenantId_fkey" FOREIGN KEY ("subscriptionId", "tenantId") REFERENCES "PlatformSubscription"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformInvoice" ADD CONSTRAINT "PlatformInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformReceipt" ADD CONSTRAINT "PlatformReceipt_invoiceId_tenantId_fkey" FOREIGN KEY ("invoiceId", "tenantId") REFERENCES "PlatformInvoice"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformReceipt" ADD CONSTRAINT "PlatformReceipt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformReceipt" ADD CONSTRAINT "PlatformReceipt_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAuditEvent" ADD CONSTRAINT "PlatformAuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAuditEvent" ADD CONSTRAINT "PlatformAuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One current owner identity per turf business, and one current agreement per tenant.
CREATE UNIQUE INDEX "TenantMembership_one_active_owner" ON "TenantMembership"("userId") WHERE "role" = 'owner' AND "isActive" = true;
CREATE UNIQUE INDEX "PlatformSubscription_one_current" ON "PlatformSubscription"("tenantId") WHERE "status" <> 'cancelled';
CREATE UNIQUE INDEX "PlatformInvoice_one_issued" ON "PlatformInvoice"("subscriptionId") WHERE "status" = 'issued';
ALTER TABLE "PlatformPlanVersion" ADD CONSTRAINT "PlatformPlanVersion_positive_amounts" CHECK ("monthlyAmount" > 0 AND "yearlyAmount" > 0 AND "currency" = 'bdt');
ALTER TABLE "PlatformSubscription" ADD CONSTRAINT "PlatformSubscription_positive_amount" CHECK ("amount" > 0 AND "currency" = 'bdt');
ALTER TABLE "PlatformInvoice" ADD CONSTRAINT "PlatformInvoice_valid_period" CHECK ("amount" > 0 AND "currency" = 'bdt' AND "periodIndex" >= 0 AND "periodEnd" > "periodStart");
ALTER TABLE "PlatformReceipt" ADD CONSTRAINT "PlatformReceipt_positive_amount" CHECK ("amount" > 0 AND "currency" = 'bdt');
