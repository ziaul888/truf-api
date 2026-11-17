-- Test-only DDL. Each "-- statement" marker separates one Prisma execution.
CREATE SCHEMA tenant_isolation_proof
-- statement
CREATE TABLE tenant_isolation_proof."Ground" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES public."Tenant"(id),
  name TEXT NOT NULL,
  UNIQUE ("tenantId", id)
)
-- statement
CREATE TABLE tenant_isolation_proof."Slot" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES public."Tenant"(id),
  "groundId" TEXT NOT NULL,
  date DATE NOT NULL,
  "startHour" INTEGER NOT NULL,
  "startMinute" INTEGER NOT NULL DEFAULT 0,
  "durationMinutes" INTEGER NOT NULL DEFAULT 60,
  price INTEGER NOT NULL,
  status public."SlotStatus" NOT NULL DEFAULT 'available',
  FOREIGN KEY ("tenantId", "groundId") REFERENCES tenant_isolation_proof."Ground"("tenantId", id),
  UNIQUE ("tenantId", id),
  UNIQUE ("groundId", date, "startHour", "startMinute")
)
-- statement
CREATE TABLE tenant_isolation_proof."Booking" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES public."Tenant"(id),
  "groundId" TEXT NOT NULL,
  "slotId" TEXT NOT NULL,
  "liveSlotId" TEXT UNIQUE,
  status public."BookingStatus" NOT NULL DEFAULT 'confirmed',
  FOREIGN KEY ("tenantId", "groundId") REFERENCES tenant_isolation_proof."Ground"("tenantId", id),
  FOREIGN KEY ("tenantId", "slotId") REFERENCES tenant_isolation_proof."Slot"("tenantId", id),
  UNIQUE ("tenantId", id)
)
-- statement
CREATE TABLE tenant_isolation_proof."BookingSlot" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES public."Tenant"(id),
  "bookingId" TEXT NOT NULL,
  "slotId" TEXT NOT NULL,
  "liveSlotId" TEXT UNIQUE,
  price INTEGER NOT NULL,
  FOREIGN KEY ("tenantId", "bookingId") REFERENCES tenant_isolation_proof."Booking"("tenantId", id),
  FOREIGN KEY ("tenantId", "slotId") REFERENCES tenant_isolation_proof."Slot"("tenantId", id),
  UNIQUE ("bookingId", "slotId")
)
-- statement
CREATE FUNCTION tenant_isolation_proof.can_access(row_tenant TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT row_tenant = NULLIF(current_setting('app.tenant_id', true), '')
    AND EXISTS (
      SELECT 1 FROM public."TenantMembership" m
      JOIN public."Tenant" t ON t.id = m."tenantId"
      JOIN public."User" u ON u.id = m."userId"
      WHERE m."tenantId" = row_tenant
        AND m."userId" = NULLIF(current_setting('app.user_id', true), '')
        AND m."isActive" AND u."isActive" AND t.status = 'active'
    )
$$
