-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PlatformAuditAction" ADD VALUE 'owner_invited';
ALTER TYPE "PlatformAuditAction" ADD VALUE 'owner_activated';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "legacyStaffAccess" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "TenantMembership" ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "OwnerInvitation" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "issuedById" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userVersion" INTEGER NOT NULL,
    "membershipVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "OwnerInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnerInvitation_requestId_key" ON "OwnerInvitation"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerInvitation_tokenHash_key" ON "OwnerInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "OwnerInvitation_membershipId_createdAt_idx" ON "OwnerInvitation"("membershipId", "createdAt");

-- CreateIndex
CREATE INDEX "OwnerInvitation_expiresAt_idx" ON "OwnerInvitation"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TenantMembership_id_tenantId_userId_key" ON "TenantMembership"("id", "tenantId", "userId");

-- AddForeignKey
ALTER TABLE "OwnerInvitation" ADD CONSTRAINT "OwnerInvitation_membershipId_tenantId_userId_fkey" FOREIGN KEY ("membershipId", "tenantId", "userId") REFERENCES "TenantMembership"("id", "tenantId", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerInvitation" ADD CONSTRAINT "OwnerInvitation_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
