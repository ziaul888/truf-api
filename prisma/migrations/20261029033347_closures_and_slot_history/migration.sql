-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SlotEventAction" ADD VALUE 'close';
ALTER TYPE "SlotEventAction" ADD VALUE 'reopen';

-- AlterTable
ALTER TABLE "Slot" ADD COLUMN     "closureId" TEXT;

-- CreateTable
CREATE TABLE "Closure" (
    "id" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "groundIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" "BlockReason" NOT NULL,
    "note" TEXT,
    "publicLabel" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liftedAt" TIMESTAMP(3),
    "liftedById" TEXT,

    CONSTRAINT "Closure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Closure_fromDate_toDate_idx" ON "Closure"("fromDate", "toDate");

-- CreateIndex
CREATE INDEX "Slot_closureId_idx" ON "Slot"("closureId");

-- CreateIndex
CREATE INDEX "SlotEvent_createdAt_idx" ON "SlotEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "Slot" ADD CONSTRAINT "Slot_closureId_fkey" FOREIGN KEY ("closureId") REFERENCES "Closure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotEvent" ADD CONSTRAINT "SlotEvent_groundId_fkey" FOREIGN KEY ("groundId") REFERENCES "Ground"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Closure" ADD CONSTRAINT "Closure_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Closure" ADD CONSTRAINT "Closure_liftedById_fkey" FOREIGN KEY ("liftedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
