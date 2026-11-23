ALTER TABLE "PlatformPlanVersion"
  ADD COLUMN "trialDays" INTEGER,
  DROP CONSTRAINT "PlatformPlanVersion_positive_amounts",
  ADD CONSTRAINT "PlatformPlanVersion_bdt_prices_or_trial" CHECK (
    "currency" = 'bdt' AND (
      ("trialDays" IS NULL AND "monthlyAmount" > 0 AND "yearlyAmount" > 0) OR
      ("trialDays" IS NOT NULL AND "trialDays" BETWEEN 1 AND 365 AND "monthlyAmount" = 0 AND "yearlyAmount" = 0)
    )
  );

ALTER TABLE "PlatformSubscription"
  ADD COLUMN "trialEndsOn" DATE,
  DROP CONSTRAINT "PlatformSubscription_positive_amount",
  ADD CONSTRAINT "PlatformSubscription_bdt_amount_or_trial" CHECK (
    "currency" = 'bdt' AND (
      ("trialEndsOn" IS NULL AND "amount" > 0) OR
      ("trialEndsOn" IS NOT NULL AND "trialEndsOn" > "anchorDate" AND "amount" = 0 AND "paidThrough" IS NULL)
    )
  );
