-- Admin switches for card, bKash and Nagad on the portal (Settings → Payments). On by default: nothing changes until an admin turns one off.
ALTER TABLE "SlotSettings" ADD COLUMN "portalCardEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "SlotSettings" ADD COLUMN "portalBkashEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "SlotSettings" ADD COLUMN "portalNagadEnabled" BOOLEAN NOT NULL DEFAULT true;
