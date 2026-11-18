-- CreateEnum
CREATE TYPE "OwnerApplicationStatus" AS ENUM ('pending', 'activated', 'rejected');

-- AlterEnum (conditional so a locally interrupted migration can be recovered safely)
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PlatformAuditAction' AND e.enumlabel = 'application_activated'
    ) THEN
        ALTER TYPE "PlatformAuditAction" ADD VALUE 'application_activated';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PlatformAuditAction' AND e.enumlabel = 'application_rejected'
    ) THEN
        ALTER TYPE "PlatformAuditAction" ADD VALUE 'application_rejected';
    END IF;
END $$;

-- CreateTable
CREATE TABLE "OwnerApplication" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "turfName" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "ownerEmail" TEXT NOT NULL,
    "passwordHash" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Dhaka',
    "currency" TEXT NOT NULL DEFAULT 'bdt',
    "status" "OwnerApplicationStatus" NOT NULL DEFAULT 'pending',
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "tenantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnerApplication_requestId_key" ON "OwnerApplication"("requestId");
CREATE UNIQUE INDEX "OwnerApplication_tenantId_key" ON "OwnerApplication"("tenantId");
CREATE INDEX "OwnerApplication_status_createdAt_idx" ON "OwnerApplication"("status", "createdAt");
CREATE INDEX "OwnerApplication_ownerEmail_status_idx" ON "OwnerApplication"("ownerEmail", "status");
CREATE INDEX "OwnerApplication_slug_status_idx" ON "OwnerApplication"("slug", "status");

-- One pending application per email and per turf handle. Rejected applicants may apply again.
CREATE UNIQUE INDEX "OwnerApplication_pending_email_key"
ON "OwnerApplication"("ownerEmail") WHERE "status" = 'pending';
CREATE UNIQUE INDEX "OwnerApplication_pending_slug_key"
ON "OwnerApplication"("slug") WHERE "status" = 'pending';

-- AddForeignKey
ALTER TABLE "OwnerApplication" ADD CONSTRAINT "OwnerApplication_reviewedById_fkey"
FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OwnerApplication" ADD CONSTRAINT "OwnerApplication_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
