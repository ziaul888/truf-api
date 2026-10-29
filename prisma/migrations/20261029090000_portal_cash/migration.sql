-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "payAtVenue" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SlotSettings" ADD COLUMN     "portalCashEnabled" BOOLEAN NOT NULL DEFAULT true;

