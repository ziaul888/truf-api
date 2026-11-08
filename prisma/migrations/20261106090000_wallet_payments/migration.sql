-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentMethod" ADD VALUE 'bkash';
ALTER TYPE "PaymentMethod" ADD VALUE 'nagad';

-- AlterTable
ALTER TABLE "SlotSettings" ADD COLUMN     "bkashNumber" TEXT,
ADD COLUMN     "nagadNumber" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "payerNumber" TEXT,
ADD COLUMN     "reference" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_method_reference_key" ON "Payment"("method", "reference");
