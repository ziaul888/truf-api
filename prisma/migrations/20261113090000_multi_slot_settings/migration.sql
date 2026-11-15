-- Multi-slot bookings become an admin setting (Settings -> Booking -> Allow multiple slots), replacing the
-- MULTI_SLOT_BOOKINGS_ENABLED env flag. Additive and safe on live data: two new columns with defaults on the
-- one-row "SlotSettings" table (metadata-only, no rewrite), plus a CHECK on the new column. Behaviour is
-- unchanged after this runs: "multiSlotEnabled" defaults to false, so bookings stay single-slot until an admin
-- turns it on. No existing column, table or index (including "Payment_method_reference_key") is touched.

-- AlterTable
ALTER TABLE "SlotSettings" ADD COLUMN "multiSlotEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "maxSlotsPerBooking" INTEGER NOT NULL DEFAULT 4;

-- Hand-written (Prisma can't express CHECK constraints): one booking holds 2 to 4 slots when multi-slot is on.
ALTER TABLE "SlotSettings" ADD CONSTRAINT "SlotSettings_maxSlotsPerBooking_range" CHECK ("maxSlotsPerBooking" BETWEEN 2 AND 4);
