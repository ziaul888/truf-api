-- 90-minute slots: a slot (and a repeat booking) can start on the half hour.
-- Safe on live data: the new columns default to 0, so every existing slot and series keeps its time.

-- AlterTable
ALTER TABLE "Slot" ADD COLUMN     "startMinute" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "BookingSeries" ADD COLUMN     "startMinute" INTEGER NOT NULL DEFAULT 0;

-- Replace the unique index: the new one is created first, so the double-booking guard never lapses.
-- Existing rows all have startMinute 0 and were unique on (groundId, date, startHour), so this can't fail.
-- CreateIndex
CREATE UNIQUE INDEX "Slot_groundId_date_startHour_startMinute_key" ON "Slot"("groundId", "date", "startHour", "startMinute");

-- DropIndex
DROP INDEX "Slot_groundId_date_startHour_key";
