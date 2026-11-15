-- "Booking money for cash bookings" becomes an admin setting (Settings -> Payments): when on, a portal cash checkout
-- also pays a deposit (a percent of the total) through the existing manual bKash / Nagad flow. Additive and safe on
-- live data: two new columns with defaults on the one-row "SlotSettings" table (metadata-only, no rewrite), plus a
-- CHECK on the new percent column. Behaviour is unchanged after this runs: "cashDepositEnabled" defaults to false.
-- No existing column, table or index (including "Payment_method_reference_key") is touched.

-- AlterTable
ALTER TABLE "SlotSettings" ADD COLUMN "cashDepositEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "cashDepositPercent" INTEGER NOT NULL DEFAULT 30;

-- Hand-written (Prisma can't express CHECK constraints): the deposit is 1 to 100 percent of the booking total.
ALTER TABLE "SlotSettings" ADD CONSTRAINT "SlotSettings_cashDepositPercent_range" CHECK ("cashDepositPercent" BETWEEN 1 AND 100);
