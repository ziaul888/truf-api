CREATE TABLE "TenantGround" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rules" TEXT,
    "address" TEXT,
    "mapUrl" TEXT,
    "hourlyPrice" INTEGER NOT NULL,
    "openingHour" INTEGER NOT NULL,
    "closingHour" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sport" "Sport" NOT NULL DEFAULT 'other',
    "format" TEXT,
    "surface" TEXT,
    "dimensions" TEXT,
    "capacity" INTEGER,
    "amenities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "availableDays" "AvailableDays" NOT NULL DEFAULT 'everyday',
    "customDays" "Weekday"[] DEFAULT ARRAY[]::"Weekday"[],
    "showOnPortal" BOOLEAN NOT NULL DEFAULT false,
    "internalNotes" TEXT,
    "peakPrice" INTEGER,
    "peakRanges" JSONB NOT NULL DEFAULT '[]',
    "slotDurationMinutes" INTEGER NOT NULL DEFAULT 60,
    "photos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    CONSTRAINT "TenantGround_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TenantGround_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "TenantSlot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "groundId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startHour" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL DEFAULT 0,
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "price" INTEGER NOT NULL,
    "status" "SlotStatus" NOT NULL DEFAULT 'available',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TenantSlot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantGround_tenantId_id_key" ON "TenantGround"("tenantId", "id");
CREATE INDEX "TenantGround_tenantId_name_idx" ON "TenantGround"("tenantId", "name");
CREATE UNIQUE INDEX "TenantSlot_tenantId_groundId_date_startHour_startMinute_key" ON "TenantSlot"("tenantId", "groundId", "date", "startHour", "startMinute");
CREATE INDEX "TenantSlot_tenantId_date_idx" ON "TenantSlot"("tenantId", "date");

ALTER TABLE "TenantSlot" ADD CONSTRAINT "TenantSlot_tenantId_groundId_fkey"
    FOREIGN KEY ("tenantId", "groundId") REFERENCES "TenantGround"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
