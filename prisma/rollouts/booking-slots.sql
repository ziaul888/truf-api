-- Run only after ALL old API instances have stopped, before enabling MULTI_SLOT_BOOKINGS_ENABLED.
-- Safe to repeat. Both repairs commit together; a failed repair leaves the rollout gate off.
BEGIN;
LOCK TABLE "Booking", "BookingSlot" IN SHARE ROW EXCLUSIVE MODE;

-- Clear stale live indexes FIRST: an old instance may already have rebooked the same slot,
-- and inserting that missing booking first would collide with the cancelled booking's live index.
UPDATE "BookingSlot" s
SET "liveSlotId" = NULL, "cancelledAt" = COALESCE(b."cancelledAt", b."updatedAt")
FROM "Booking" b
WHERE s."bookingId" = b."id" AND b."status" = 'cancelled'
  AND (s."liveSlotId" IS NOT NULL OR s."cancelledAt" IS NULL);

INSERT INTO "BookingSlot" ("id", "bookingId", "slotId", "liveSlotId", "price", "cancelledAt", "createdAt")
SELECT gen_random_uuid()::text, b."id", b."slotId",
    CASE WHEN b."status" = 'cancelled' THEN NULL ELSE b."liveSlotId" END,
    b."amount", CASE WHEN b."status" = 'cancelled' THEN COALESCE(b."cancelledAt", b."updatedAt") END,
    b."createdAt"
FROM "Booking" b
WHERE NOT EXISTS (SELECT 1 FROM "BookingSlot" s WHERE s."bookingId" = b."id")
ON CONFLICT ("bookingId", "slotId") DO NOTHING;
COMMIT;
