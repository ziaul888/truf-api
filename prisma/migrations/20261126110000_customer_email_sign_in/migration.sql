-- Email sign-in is opt-in. Existing contact emails can be entered by staff or guests.
ALTER TABLE "Customer" ADD COLUMN "verifiedEmail" TEXT, ADD COLUMN "emailVersion" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "Customer_verifiedEmail_key" ON "Customer"("verifiedEmail");

CREATE TABLE "CustomerEmailCode" (
    "key" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resendAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CustomerEmailCode_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "CustomerEmailCode_expiresAt_idx" ON "CustomerEmailCode"("expiresAt");

CREATE FUNCTION public.add_customer_email_sign_in(namespace text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I."Customer" ADD COLUMN "verifiedEmail" TEXT, ADD COLUMN "emailVersion" INTEGER NOT NULL DEFAULT 0', namespace);
  EXECUTE format('CREATE UNIQUE INDEX "Customer_verifiedEmail_key" ON %I."Customer"("verifiedEmail")', namespace);
  EXECUTE format('CREATE TABLE %I."CustomerEmailCode" (LIKE public."CustomerEmailCode" INCLUDING ALL)', namespace);
END;
$$;

-- Upgrade existing turf schemas and extend the baseline for future turfs.
ALTER FUNCTION public.provision_turf_dashboard(text) RENAME TO provision_turf_dashboard_base;
CREATE FUNCTION public.provision_turf_dashboard(turf_id text)
RETURNS text
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  turf_schema text;
BEGIN
  turf_schema := public.provision_turf_dashboard_base(turf_id);
  IF to_regclass(format('%I."CustomerEmailCode"', turf_schema)) IS NULL THEN
    PERFORM public.add_customer_email_sign_in(turf_schema);
  END IF;
  RETURN turf_schema;
END;
$$;

DO $$
DECLARE
  turf_schema text;
BEGIN
  FOR turf_schema IN
    SELECT nspname FROM pg_namespace
    WHERE nspname ~ '^turf_[0-9a-f]{32}$'
  LOOP
    PERFORM public.add_customer_email_sign_in(turf_schema);
  END LOOP;
END;
$$;
