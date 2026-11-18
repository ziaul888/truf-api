CREATE TABLE "TenantSetup" (
  "tenantId" TEXT NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}',
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TenantSetup_pkey" PRIMARY KEY ("tenantId")
);

ALTER TABLE "TenantSetup"
ADD CONSTRAINT "TenantSetup_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
