-- Spare Parts & Warranty Management — OPERATIONAL TRACKING ONLY.
-- No relation to any accounting table; purchaseRate is information only.

-- CreateTable
CREATE TABLE "SparePart" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "partNumber" TEXT,
    "serialNo" TEXT NOT NULL,
    "brand" TEXT,
    "model" TEXT,
    "supplierName" TEXT,
    "purchaseDate" TIMESTAMP(3),
    "invoiceNo" TEXT,
    "purchaseRate" DECIMAL(14,2),
    "warrantyApplicable" BOOLEAN NOT NULL DEFAULT false,
    "warrantyMonths" INTEGER,
    "warrantyStartDate" TIMESTAMP(3),
    "warrantyExpiryDate" TIMESTAMP(3),
    "warrantyReviewedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "currentVehicleId" TEXT,
    "installedOn" TIMESTAMP(3),
    "installKm" DECIMAL(12,1),
    "remarks" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SparePart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SparePartEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "vehicleId" TEXT,
    "kmReading" DECIMAL(12,1),
    "workshop" TEXT,
    "remarks" TEXT,
    "claimStatus" TEXT,
    "relatedPartId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SparePartEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SparePart_tenantId_firmId_serialNo_key" ON "SparePart"("tenantId", "firmId", "serialNo");
CREATE INDEX "SparePart_tenantId_firmId_status_idx" ON "SparePart"("tenantId", "firmId", "status");
CREATE INDEX "SparePart_tenantId_firmId_warrantyExpiryDate_idx" ON "SparePart"("tenantId", "firmId", "warrantyExpiryDate");
CREATE INDEX "SparePart_tenantId_firmId_currentVehicleId_idx" ON "SparePart"("tenantId", "firmId", "currentVehicleId");
CREATE INDEX "SparePartEvent_partId_date_idx" ON "SparePartEvent"("partId", "date");
CREATE INDEX "SparePartEvent_tenantId_vehicleId_idx" ON "SparePartEvent"("tenantId", "vehicleId");

-- AddForeignKey
ALTER TABLE "SparePartEvent" ADD CONSTRAINT "SparePartEvent_partId_fkey" FOREIGN KEY ("partId") REFERENCES "SparePart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security: tenant isolation like every other table
ALTER TABLE "SparePart" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SparePart" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "SparePart";
CREATE POLICY tenant_isolation ON "SparePart"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS platform_bypass ON "SparePart";
CREATE POLICY platform_bypass ON "SparePart"
  USING (current_setting('app.bypass_rls', true) = 'on')
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "SparePartEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SparePartEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "SparePartEvent";
CREATE POLICY tenant_isolation ON "SparePartEvent"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS platform_bypass ON "SparePartEvent";
CREATE POLICY platform_bypass ON "SparePartEvent"
  USING (current_setting('app.bypass_rls', true) = 'on')
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on');
