-- AlterEnum
ALTER TYPE "BookingEventType" ADD VALUE 'cancel_requested';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "cancelRequestedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "receivedAt" TIMESTAMP(3);

-- Backfill: money already received counts on the day it was recorded, as before.
UPDATE "Payment" SET "receivedAt" = "createdAt" WHERE "status" IN ('succeeded', 'refunded');

-- A TrxID is unique per method only among live payments: a rejected (failed) or deleted one can be
-- used again. Prisma can't express a partial unique index, so it lives here and not in schema.prisma.
-- Keep the name: the API maps a violation of "Payment_method_reference_key" to 409 REFERENCE_ALREADY_USED.
DROP INDEX "Payment_method_reference_key";
CREATE UNIQUE INDEX "Payment_method_reference_key" ON "Payment"("method", "reference")
  WHERE "status" <> 'failed' AND "deletedAt" IS NULL;
