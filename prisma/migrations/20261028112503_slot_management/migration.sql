/*
  Warnings:

  - You are about to drop the column `blockedReason` on the `Slot` table. All the data in the column will be lost.
  - Added the required column `price` to the `Slot` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "BlockReason" AS ENUM ('maintenance', 'reserved', 'event', 'weather', 'other');

-- CreateEnum
CREATE TYPE "SlotEventAction" AS ENUM ('block', 'unblock');

-- AlterTable
ALTER TABLE "Slot" DROP COLUMN "blockedReason",
ADD COLUMN     "blockNote" TEXT,
ADD COLUMN     "blockReason" "BlockReason",
ADD COLUMN     "blockedAt" TIMESTAMP(3),
ADD COLUMN     "blockedById" TEXT,
ADD COLUMN     "durationMinutes" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "price" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "SlotEvent" (
    "id" TEXT NOT NULL,
    "slotId" TEXT,
    "groundId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startHour" INTEGER NOT NULL,
    "action" "SlotEventAction" NOT NULL,
    "reason" "BlockReason",
    "note" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlotEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlotSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "advanceBookingDays" INTEGER NOT NULL DEFAULT 30,
    "autoGenerate" BOOLEAN NOT NULL DEFAULT true,
    "cancellationCutoffHours" INTEGER NOT NULL DEFAULT 2,
    "notifyCustomerOnBlock" BOOLEAN NOT NULL DEFAULT true,
    "notifyAdminOnBooking" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlotSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SlotEvent_slotId_idx" ON "SlotEvent"("slotId");

-- CreateIndex
CREATE INDEX "SlotEvent_groundId_date_idx" ON "SlotEvent"("groundId", "date");

-- AddForeignKey
ALTER TABLE "Slot" ADD CONSTRAINT "Slot_blockedById_fkey" FOREIGN KEY ("blockedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotEvent" ADD CONSTRAINT "SlotEvent_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "Slot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotEvent" ADD CONSTRAINT "SlotEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
