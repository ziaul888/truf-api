ALTER TABLE "PlatformPlanVersion"
  ADD COLUMN "features" TEXT[] NOT NULL DEFAULT ARRAY['staff', 'reports', 'website', 'refunds']::TEXT[];
