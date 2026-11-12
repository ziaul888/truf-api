-- Multi-slot bookings: a booking can hold 1 to 4 slots (one ground, one date), one row each in "BookingSlot".
-- Additive and safe on live data: it only creates a new table with its indexes and foreign keys, then
-- copies every existing booking's single slot into it. No existing table, column or index is changed or
-- dropped (the hand-written partial index "Payment_method_reference_key" is not touched). The copy is
-- idempotent: it skips bookings that already have a row, so running it twice adds nothing.
-- A booking created by an old release during the deploy overlap has no row yet (the code falls back to
-- Booking.slotId for it). Keep MULTI_SLOT_BOOKINGS_ENABLED=false during rollout. After ALL old
-- instances stop, run `yarn db:reconcile:booking-slots` (prisma/rollouts/booking-slots.sql), then
-- enable multi-slot bookings. The repair clears stale live indexes BEFORE inserting missing rows,
-- because an old instance may already have rebooked one of those cancelled slots.

-- CreateTable
CREATE TABLE "BookingSlot" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "liveSlotId" TEXT,
    "price" INTEGER NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingSlot_liveSlotId_key" ON "BookingSlot"("liveSlotId");

-- CreateIndex
CREATE INDEX "BookingSlot_bookingId_idx" ON "BookingSlot"("bookingId");

-- CreateIndex
CREATE INDEX "BookingSlot_slotId_idx" ON "BookingSlot"("slotId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingSlot_bookingId_slotId_key" ON "BookingSlot"("bookingId", "slotId");

-- AddForeignKey
ALTER TABLE "BookingSlot" ADD CONSTRAINT "BookingSlot_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingSlot" ADD CONSTRAINT "BookingSlot_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "Slot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: each existing booking gets one row for its slot (price = the booking's amount, which was the
-- slot price). A cancelled booking's row has liveSlotId NULL (Booking.liveSlotId is already NULL) and
-- cancelledAt set. gen_random_uuid() is built in from PostgreSQL 13.
INSERT INTO "BookingSlot" ("id", "bookingId", "slotId", "liveSlotId", "price", "cancelledAt", "createdAt")
SELECT
    gen_random_uuid()::text,
    b."id",
    b."slotId",
    b."liveSlotId",
    b."amount",
    CASE WHEN b."status" = 'cancelled' THEN COALESCE(b."cancelledAt", b."updatedAt") END,
    b."createdAt"
FROM "Booking" b
WHERE NOT EXISTS (SELECT 1 FROM "BookingSlot" s WHERE s."bookingId" = b."id");
