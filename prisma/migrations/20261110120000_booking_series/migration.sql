-- Repeat bookings (booking series): a series row, the dates it skipped, and Booking.seriesId on the bookings it made.
-- CreateEnum
CREATE TYPE "BookingSeriesStatus" AS ENUM ('active', 'stopped');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "seriesId" TEXT;

-- CreateTable
CREATE TABLE "BookingSeries" (
    "id" TEXT NOT NULL,
    "groundId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "contactEmail" TEXT,
    "startHour" INTEGER NOT NULL,
    "weekdays" TEXT[],
    "fromDate" DATE NOT NULL,
    "untilDate" DATE,
    "status" "BookingSeriesStatus" NOT NULL DEFAULT 'active',
    "bookedThrough" DATE,
    "notes" TEXT,
    "createdById" TEXT,
    "stoppedAt" TIMESTAMP(3),
    "stoppedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BookingSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingSeriesSkip" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingSeriesSkip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingSeries_groundId_idx" ON "BookingSeries"("groundId");

-- CreateIndex
CREATE INDEX "BookingSeries_customerId_idx" ON "BookingSeries"("customerId");

-- CreateIndex
CREATE INDEX "BookingSeries_status_idx" ON "BookingSeries"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BookingSeriesSkip_seriesId_date_key" ON "BookingSeriesSkip"("seriesId", "date");

-- CreateIndex
CREATE INDEX "Booking_seriesId_idx" ON "Booking"("seriesId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "BookingSeries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingSeries" ADD CONSTRAINT "BookingSeries_groundId_fkey" FOREIGN KEY ("groundId") REFERENCES "Ground"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingSeries" ADD CONSTRAINT "BookingSeries_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingSeries" ADD CONSTRAINT "BookingSeries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingSeries" ADD CONSTRAINT "BookingSeries_stoppedById_fkey" FOREIGN KEY ("stoppedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingSeriesSkip" ADD CONSTRAINT "BookingSeriesSkip_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "BookingSeries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
