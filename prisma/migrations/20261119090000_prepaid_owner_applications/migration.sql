ALTER TABLE "OwnerApplication"
  ADD COLUMN "paymentMethod" "PlatformReceiptMethod",
  ADD COLUMN "paymentReference" TEXT,
  ADD COLUMN "paymentDate" DATE,
  ADD CONSTRAINT "OwnerApplication_payment_complete" CHECK (
    num_nonnulls("paymentMethod", "paymentReference", "paymentDate") IN (0, 3)
  );

CREATE UNIQUE INDEX "OwnerApplication_pending_payment_key"
  ON "OwnerApplication" ("paymentMethod", "paymentReference")
  WHERE "status" = 'pending' AND "paymentReference" IS NOT NULL;

ALTER TYPE "PlatformAuditAction" ADD VALUE 'payment_methods_updated';
