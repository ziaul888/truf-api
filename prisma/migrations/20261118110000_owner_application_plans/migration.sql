-- Existing applications remain readable. New submissions require both fields in API validation.
ALTER TABLE "OwnerApplication"
ADD COLUMN "planVersionId" TEXT,
ADD COLUMN "billingInterval" "PlatformBillingInterval";

CREATE INDEX "OwnerApplication_planVersionId_idx"
ON "OwnerApplication"("planVersionId");

ALTER TABLE "OwnerApplication"
ADD CONSTRAINT "OwnerApplication_planVersionId_fkey"
FOREIGN KEY ("planVersionId") REFERENCES "PlatformPlanVersion"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
