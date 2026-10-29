-- AlterTable
ALTER TABLE "Ground" ADD COLUMN     "peakPrice" INTEGER,
ADD COLUMN     "peakRanges" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "photos" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "slotDurationMinutes" INTEGER NOT NULL DEFAULT 60;
