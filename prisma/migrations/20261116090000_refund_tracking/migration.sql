-- "Refund tracking": bKash / Nagad refunds are paid back by hand, so staff record when the money was sent back.
-- Additive and safe on live data: three nullable columns on "Payment" (metadata-only, no rewrite) and a foreign key
-- on the new "refundSentById" column. Existing rows stay NULL (refund not yet recorded as sent); behaviour of cancel,
-- refund and revenue is unchanged. No existing column, table or index (including "Payment_method_reference_key") is touched.

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "refundSentAt" TIMESTAMP(3),
ADD COLUMN "refundSentById" TEXT,
ADD COLUMN "refundNote" TEXT;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_refundSentById_fkey" FOREIGN KEY ("refundSentById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: refunds made before this feature were already paid back by hand, so they are not "due". Marked sent
-- at their refund time with no staff member and a note saying why; only refunds after this deploy start as due.
UPDATE "Payment"
SET "refundSentAt" = "refundedAt", "refundNote" = 'Before refund tracking'
WHERE "status" = 'refunded' AND "method" IN ('bkash', 'nagad') AND "refundedAt" IS NOT NULL
  AND "refundSentAt" IS NULL AND "deletedAt" IS NULL;
