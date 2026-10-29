-- CreateEnum
CREATE TYPE "Sport" AS ENUM ('football', 'cricket', 'badminton', 'tennis', 'hockey', 'basketball', 'other');

-- CreateEnum
CREATE TYPE "AvailableDays" AS ENUM ('everyday', 'weekdays', 'weekends', 'custom');

-- CreateEnum
CREATE TYPE "Weekday" AS ENUM ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun');

-- AlterTable
ALTER TABLE "Ground" ADD COLUMN     "amenities" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "availableDays" "AvailableDays" NOT NULL DEFAULT 'everyday',
ADD COLUMN     "capacity" INTEGER,
ADD COLUMN     "customDays" "Weekday"[] DEFAULT ARRAY[]::"Weekday"[],
ADD COLUMN     "dimensions" TEXT,
ADD COLUMN     "format" TEXT,
ADD COLUMN     "internalNotes" TEXT,
ADD COLUMN     "showOnPortal" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sport" "Sport" NOT NULL DEFAULT 'other',
ADD COLUMN     "surface" TEXT;

-- CreateIndex
CREATE INDEX "Ground_sport_idx" ON "Ground"("sport");
