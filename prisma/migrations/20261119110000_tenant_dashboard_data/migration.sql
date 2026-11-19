-- Turf operation tables use the dashboard's Prisma models in an isolated schema.
-- Future changes to these models must migrate existing turf schemas and update this baseline.
CREATE OR REPLACE FUNCTION public.provision_turf_dashboard(turf_id text)
RETURNS text
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  namespace text;
BEGIN
  IF turf_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR NOT EXISTS (SELECT 1 FROM public."Tenant" WHERE id = turf_id) THEN
    RAISE EXCEPTION 'Invalid turf';
  END IF;

  namespace := 'turf_' || replace(turf_id, '-', '');
  PERFORM pg_advisory_xact_lock(hashtextextended(turf_id, 559314));
  IF to_regnamespace(namespace) IS NOT NULL THEN
    RETURN namespace;
  END IF;

  EXECUTE format('CREATE SCHEMA %I', namespace);
  PERFORM set_config('search_path', format('%I, pg_catalog', namespace), true);

  CREATE TYPE "AvailableDays" AS ENUM ('everyday', 'weekdays', 'weekends', 'custom');
  CREATE TYPE "BlockReason" AS ENUM ('maintenance', 'reserved', 'event', 'weather', 'other');
  CREATE TYPE "BookingEventType" AS ENUM ('created', 'payment_received', 'confirmed', 'cancelled', 'refunded', 'email_sent', 'completed', 'cancel_requested', 'no_show');
  CREATE TYPE "BookingPaymentStatus" AS ENUM ('unpaid', 'partial', 'paid', 'refunded', 'failed');
  CREATE TYPE "BookingSeriesStatus" AS ENUM ('active', 'stopped');
  CREATE TYPE "BookingSource" AS ENUM ('portal', 'staff');
  CREATE TYPE "BookingStatus" AS ENUM ('pending', 'confirmed', 'cancelled', 'completed', 'no_show');
  CREATE TYPE "PaymentMethod" AS ENUM ('card', 'cash', 'bank_transfer', 'bkash', 'nagad');
  CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'succeeded', 'failed', 'refunded');
  CREATE TYPE "SlotEventAction" AS ENUM ('block', 'unblock', 'close', 'reopen');
  CREATE TYPE "SlotStatus" AS ENUM ('available', 'booked', 'blocked', 'held');
  CREATE TYPE "Sport" AS ENUM ('football', 'cricket', 'badminton', 'tennis', 'hockey', 'basketball', 'other');
  CREATE TYPE "Weekday" AS ENUM ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun');

  CREATE TABLE "Booking" (
    "id" text NOT NULL,
    "groundId" text NOT NULL,
    "slotId" text NOT NULL,
    "customerId" text NOT NULL,
    "status" "BookingStatus" DEFAULT 'pending'::"BookingStatus" NOT NULL,
    "amount" integer NOT NULL,
    "cancelledAt" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp without time zone NOT NULL,
    "deletedAt" timestamp without time zone,
    "bookingNumber" text NOT NULL,
    "cancelReason" text,
    "cancelledById" text,
    "confirmedAt" timestamp without time zone,
    "contactEmail" text,
    "contactName" text NOT NULL,
    "contactPhone" text NOT NULL,
    "createdById" text,
    "dueDate" date,
    "dueNote" text,
    "dueReminderSentAt" timestamp without time zone,
    "liveSlotId" text,
    "notes" text,
    "paymentStatus" "BookingPaymentStatus" DEFAULT 'unpaid'::"BookingPaymentStatus" NOT NULL,
    "serviceFee" integer DEFAULT 0 NOT NULL,
    "source" "BookingSource" NOT NULL,
    "stripeCheckoutSessionId" text,
    "total" integer NOT NULL,
    "payAtVenue" boolean DEFAULT false NOT NULL,
    "cancelRequestedAt" timestamp without time zone,
    "seriesId" text,
    CONSTRAINT "Booking_pkey" PRIMARY KEY (id)
  );

  CREATE TABLE "BookingEvent" (
    "id" text NOT NULL,
    "bookingId" text NOT NULL,
    "type" "BookingEventType" NOT NULL,
    "detail" text,
    "userId" text,
    "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "BookingEvent_pkey" PRIMARY KEY (id)
  );

  CREATE TABLE "BookingSeries" (
    "id" text NOT NULL,
    "groundId" text NOT NULL,
    "customerId" text NOT NULL,
    "contactName" text NOT NULL,
    "contactPhone" text NOT NULL,
    "contactEmail" text,
    "startHour" integer NOT NULL,
    "weekdays" text[],
    "fromDate" date NOT NULL,
    "untilDate" date,
    "status" "BookingSeriesStatus" DEFAULT 'active'::"BookingSeriesStatus" NOT NULL,
    "bookedThrough" date,
    "notes" text,
    "createdById" text,
    "stoppedAt" timestamp without time zone,
    "stoppedById" text,
    "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp without time zone NOT NULL,
    "deletedAt" timestamp without time zone,
    "startMinute" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "BookingSeries_pkey" PRIMARY KEY (id)
  );

  CREATE TABLE "BookingSeriesSkip" (
    "id" text NOT NULL,
    "seriesId" text NOT NULL,
    "date" date NOT NULL,
    "reason" text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "BookingSeriesSkip_pkey" PRIMARY KEY (id)
  );

  CREATE TABLE "BookingSlot" (
    "id" text NOT NULL,
    "bookingId" text NOT NULL,
    "slotId" text NOT NULL,
    "liveSlotId" text,
    "price" integer NOT NULL,
    "cancelledAt" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "BookingSlot_pkey" PRIMARY KEY (id)
  );

  CREATE TABLE "Closure" (
    "id" text NOT NULL,
    "fromDate" date NOT NULL,
    "toDate" date NOT NULL,
    "groundIds" text[] DEFAULT ARRAY[]::text[],
    "reason" "BlockReason" NOT NULL,
    "note" text,
    "publicLabel" text,
    "createdById" text,
    "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "liftedAt" timestamp without time zone,
    "liftedById" text,
    CONSTRAINT "Closure_pkey" PRIMARY KEY (id)
  );

  CREATE TABLE "Customer" (
    "id" text NOT NULL,
    "name" text NOT NULL,
    "email" text,
    "phone" text,
    "stripeCustomerId" text,
    "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp without time zone NOT NULL,
    "deletedAt" timestamp without time zone,
    "adminNote" text,
    "sessionVersion" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "Customer_pkey" PRIMARY KEY (id)
  );

  CREATE TABLE "Ground" (
    "id" text NOT NULL,
    "name" text NOT NULL,
    "description" text,
    "address" text,
    "hourlyPrice" integer NOT NULL,
    "openingHour" integer NOT NULL,
    "closingHour" integer NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp without time zone NOT NULL,
    "amenities" text[] DEFAULT ARRAY[]::text[],
    "availableDays" "AvailableDays" DEFAULT 'everyday'::"AvailableDays" NOT NULL,
    "capacity" integer,
    "customDays" "Weekday"[] DEFAULT ARRAY[]::"Weekday"[],
    "dimensions" text,
    "format" text,
    "internalNotes" text,
    "showOnPortal" boolean DEFAULT true NOT NULL,
    "sport" "Sport" DEFAULT 'other'::"Sport" NOT NULL,
    "surface" text,
    "peakPrice" integer,
    "peakRanges" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "photos" text[] DEFAULT ARRAY[]::text[],
    "slotDurationMinutes" integer DEFAULT 60 NOT NULL,
    "mapUrl" text,
    "rules" text,
    CONSTRAINT "Ground_pkey" PRIMARY KEY (id)
  );

  CREATE TABLE "Payment" (
    "id" text NOT NULL,
    "bookingId" text NOT NULL,
    "stripePaymentIntentId" text,
    "amount" integer NOT NULL,
    "currency" text NOT NULL,
    "status" "PaymentStatus" DEFAULT 'pending'::"PaymentStatus" NOT NULL,
    "stripeRefundId" text,
    "refundedAt" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp without time zone NOT NULL,
    "deletedAt" timestamp without time zone,
    "cardLast4" text,
    "method" "PaymentMethod" NOT NULL,
    "note" text,
    "recordedById" text,
    "payerNumber" text,
    "reference" text,
    "receivedAt" timestamp without time zone,
    "refundSentAt" timestamp without time zone,
    "refundSentById" text,
    "refundNote" text,
    CONSTRAINT "Payment_pkey" PRIMARY KEY (id)
  );

  CREATE TABLE "Slot" (
    "id" text NOT NULL,
    "groundId" text NOT NULL,
    "date" date NOT NULL,
    "startHour" integer NOT NULL,
    "status" "SlotStatus" DEFAULT 'available'::"SlotStatus" NOT NULL,
    "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp without time zone NOT NULL,
    "blockNote" text,
    "blockReason" "BlockReason",
    "blockedAt" timestamp without time zone,
    "blockedById" text,
    "durationMinutes" integer DEFAULT 60 NOT NULL,
    "price" integer NOT NULL,
    "closureId" text,
    "heldByBookingId" text,
    "heldUntil" timestamp without time zone,
    "startMinute" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "Slot_pkey" PRIMARY KEY (id)
  );

  CREATE TABLE "SlotEvent" (
    "id" text NOT NULL,
    "slotId" text,
    "groundId" text NOT NULL,
    "date" date NOT NULL,
    "startHour" integer NOT NULL,
    "action" "SlotEventAction" NOT NULL,
    "reason" "BlockReason",
    "note" text,
    "userId" text,
    "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "SlotEvent_pkey" PRIMARY KEY (id)
  );

  CREATE UNIQUE INDEX "Booking_bookingNumber_key" ON "Booking" USING btree ("bookingNumber");
  CREATE INDEX "Booking_createdAt_idx" ON "Booking" USING btree ("createdAt");
  CREATE INDEX "Booking_customerId_idx" ON "Booking" USING btree ("customerId");
  CREATE INDEX "Booking_groundId_idx" ON "Booking" USING btree ("groundId");
  CREATE UNIQUE INDEX "Booking_liveSlotId_key" ON "Booking" USING btree ("liveSlotId");
  CREATE INDEX "Booking_seriesId_idx" ON "Booking" USING btree ("seriesId");
  CREATE INDEX "Booking_slotId_idx" ON "Booking" USING btree ("slotId");
  CREATE INDEX "Booking_status_idx" ON "Booking" USING btree (status);
  CREATE UNIQUE INDEX "Booking_stripeCheckoutSessionId_key" ON "Booking" USING btree ("stripeCheckoutSessionId");
  CREATE INDEX "BookingEvent_bookingId_idx" ON "BookingEvent" USING btree ("bookingId");
  CREATE INDEX "BookingEvent_createdAt_idx" ON "BookingEvent" USING btree ("createdAt");
  CREATE INDEX "BookingSeries_customerId_idx" ON "BookingSeries" USING btree ("customerId");
  CREATE INDEX "BookingSeries_groundId_idx" ON "BookingSeries" USING btree ("groundId");
  CREATE INDEX "BookingSeries_status_idx" ON "BookingSeries" USING btree (status);
  CREATE UNIQUE INDEX "BookingSeriesSkip_seriesId_date_key" ON "BookingSeriesSkip" USING btree ("seriesId", date);
  CREATE INDEX "BookingSlot_bookingId_idx" ON "BookingSlot" USING btree ("bookingId");
  CREATE UNIQUE INDEX "BookingSlot_bookingId_slotId_key" ON "BookingSlot" USING btree ("bookingId", "slotId");
  CREATE UNIQUE INDEX "BookingSlot_liveSlotId_key" ON "BookingSlot" USING btree ("liveSlotId");
  CREATE INDEX "BookingSlot_slotId_idx" ON "BookingSlot" USING btree ("slotId");
  CREATE INDEX "Closure_fromDate_toDate_idx" ON "Closure" USING btree ("fromDate", "toDate");
  CREATE INDEX "Customer_email_idx" ON "Customer" USING btree (email);
  CREATE UNIQUE INDEX "Customer_phone_key" ON "Customer" USING btree (phone);
  CREATE UNIQUE INDEX "Customer_stripeCustomerId_key" ON "Customer" USING btree ("stripeCustomerId");
  CREATE INDEX "Ground_sport_idx" ON "Ground" USING btree (sport);
  CREATE INDEX "Payment_bookingId_idx" ON "Payment" USING btree ("bookingId");
  CREATE INDEX "Payment_createdAt_idx" ON "Payment" USING btree ("createdAt");
  CREATE UNIQUE INDEX "Payment_method_reference_key" ON "Payment" USING btree (method, reference) WHERE ((status <> 'failed'::"PaymentStatus") AND ("deletedAt" IS NULL));
  CREATE INDEX "Payment_status_idx" ON "Payment" USING btree (status);
  CREATE UNIQUE INDEX "Payment_stripePaymentIntentId_key" ON "Payment" USING btree ("stripePaymentIntentId");
  CREATE UNIQUE INDEX "Payment_stripeRefundId_key" ON "Payment" USING btree ("stripeRefundId");
  CREATE INDEX "Slot_closureId_idx" ON "Slot" USING btree ("closureId");
  CREATE INDEX "Slot_date_idx" ON "Slot" USING btree (date);
  CREATE UNIQUE INDEX "Slot_groundId_date_startHour_startMinute_key" ON "Slot" USING btree ("groundId", date, "startHour", "startMinute");
  CREATE INDEX "Slot_groundId_idx" ON "Slot" USING btree ("groundId");
  CREATE INDEX "Slot_heldUntil_idx" ON "Slot" USING btree ("heldUntil");
  CREATE INDEX "Slot_status_idx" ON "Slot" USING btree (status);
  CREATE INDEX "SlotEvent_createdAt_idx" ON "SlotEvent" USING btree ("createdAt");
  CREATE INDEX "SlotEvent_groundId_date_idx" ON "SlotEvent" USING btree ("groundId", date);
  CREATE INDEX "SlotEvent_slotId_idx" ON "SlotEvent" USING btree ("slotId");

  ALTER TABLE "Booking" ADD CONSTRAINT "Booking_cancelledById_fkey"
    FOREIGN KEY ("cancelledById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;
  ALTER TABLE "Booking" ADD CONSTRAINT "Booking_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;
  ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  ALTER TABLE "Booking" ADD CONSTRAINT "Booking_groundId_fkey"
    FOREIGN KEY ("groundId") REFERENCES "Ground"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  ALTER TABLE "Booking" ADD CONSTRAINT "Booking_seriesId_fkey"
    FOREIGN KEY ("seriesId") REFERENCES "BookingSeries"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  ALTER TABLE "Booking" ADD CONSTRAINT "Booking_slotId_fkey"
    FOREIGN KEY ("slotId") REFERENCES "Slot"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  ALTER TABLE "BookingEvent" ADD CONSTRAINT "BookingEvent_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  ALTER TABLE "BookingEvent" ADD CONSTRAINT "BookingEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;
  ALTER TABLE "BookingSeries" ADD CONSTRAINT "BookingSeries_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;
  ALTER TABLE "BookingSeries" ADD CONSTRAINT "BookingSeries_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  ALTER TABLE "BookingSeries" ADD CONSTRAINT "BookingSeries_groundId_fkey"
    FOREIGN KEY ("groundId") REFERENCES "Ground"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  ALTER TABLE "BookingSeries" ADD CONSTRAINT "BookingSeries_stoppedById_fkey"
    FOREIGN KEY ("stoppedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;
  ALTER TABLE "BookingSeriesSkip" ADD CONSTRAINT "BookingSeriesSkip_seriesId_fkey"
    FOREIGN KEY ("seriesId") REFERENCES "BookingSeries"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  ALTER TABLE "BookingSlot" ADD CONSTRAINT "BookingSlot_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  ALTER TABLE "BookingSlot" ADD CONSTRAINT "BookingSlot_slotId_fkey"
    FOREIGN KEY ("slotId") REFERENCES "Slot"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  ALTER TABLE "Closure" ADD CONSTRAINT "Closure_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;
  ALTER TABLE "Closure" ADD CONSTRAINT "Closure_liftedById_fkey"
    FOREIGN KEY ("liftedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;
  ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  ALTER TABLE "Payment" ADD CONSTRAINT "Payment_recordedById_fkey"
    FOREIGN KEY ("recordedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;
  ALTER TABLE "Payment" ADD CONSTRAINT "Payment_refundSentById_fkey"
    FOREIGN KEY ("refundSentById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;
  ALTER TABLE "Slot" ADD CONSTRAINT "Slot_blockedById_fkey"
    FOREIGN KEY ("blockedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;
  ALTER TABLE "Slot" ADD CONSTRAINT "Slot_closureId_fkey"
    FOREIGN KEY ("closureId") REFERENCES "Closure"(id) ON UPDATE CASCADE ON DELETE SET NULL;
  ALTER TABLE "Slot" ADD CONSTRAINT "Slot_groundId_fkey"
    FOREIGN KEY ("groundId") REFERENCES "Ground"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  ALTER TABLE "SlotEvent" ADD CONSTRAINT "SlotEvent_groundId_fkey"
    FOREIGN KEY ("groundId") REFERENCES "Ground"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  ALTER TABLE "SlotEvent" ADD CONSTRAINT "SlotEvent_slotId_fkey"
    FOREIGN KEY ("slotId") REFERENCES "Slot"(id) ON UPDATE CASCADE ON DELETE SET NULL;
  ALTER TABLE "SlotEvent" ADD CONSTRAINT "SlotEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;

  -- The dashboard reads staff names for attribution.
  EXECUTE format(
    'CREATE VIEW "User" AS SELECT u.id, u.name FROM public."User" u
     JOIN public."TenantMembership" m ON m."userId" = u.id WHERE m."tenantId" = %L',
    turf_id
  );

  -- Preserve IDs so existing ground and slot links still resolve.
  INSERT INTO "Ground" (
    "id", "name", "description", "rules", "address", "mapUrl", "hourlyPrice", "openingHour",
    "closingHour", "isActive", "createdAt", "updatedAt", "sport", "format", "surface",
    "dimensions", "capacity", "amenities", "availableDays", "customDays", "showOnPortal",
    "internalNotes", "peakPrice", "peakRanges", "slotDurationMinutes", "photos"
  )
  SELECT
    "id", "name", "description", "rules", "address", "mapUrl", "hourlyPrice", "openingHour",
    "closingHour", "isActive", "createdAt", "updatedAt", "sport"::text::"Sport", "format",
    "surface", "dimensions", "capacity", "amenities",
    "availableDays"::text::"AvailableDays", "customDays"::text::"Weekday"[], "showOnPortal",
    "internalNotes", "peakPrice", "peakRanges", "slotDurationMinutes", "photos"
  FROM public."TenantGround" WHERE "tenantId" = turf_id;

  INSERT INTO "Slot" (
    "id", "groundId", "date", "startHour", "startMinute", "durationMinutes", "price",
    "status", "createdAt", "updatedAt"
  )
  SELECT
    "id", "groundId", "date", "startHour", "startMinute", "durationMinutes", "price",
    "status"::text::"SlotStatus", "createdAt", "updatedAt"
  FROM public."TenantSlot" WHERE "tenantId" = turf_id;

  RETURN namespace;
END;
$$;
