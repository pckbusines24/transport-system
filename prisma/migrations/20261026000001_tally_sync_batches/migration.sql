-- Tally sync: ledger signature on the export register, and downloaded files
-- awaiting the user's import confirmation.
ALTER TABLE "TallyExportEntry" ADD COLUMN IF NOT EXISTS "ledgerSig" TEXT;

CREATE TABLE IF NOT EXISTS "TallyExportBatch" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "firmId" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "xml" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "ops" JSONB NOT NULL,
  "vouchers" INTEGER NOT NULL DEFAULT 0,
  "deletes" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "TallyExportBatch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TallyExportBatch_firmId_module_status_idx" ON "TallyExportBatch"("firmId", "module", "status");
CREATE INDEX IF NOT EXISTS "TallyExportBatch_tenantId_idx" ON "TallyExportBatch"("tenantId");

-- tenant isolation, same pattern as every tenant table
ALTER TABLE "TallyExportBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TallyExportBatch" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TallyExportBatch";
CREATE POLICY tenant_isolation ON "TallyExportBatch"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS platform_bypass ON "TallyExportBatch";
CREATE POLICY platform_bypass ON "TallyExportBatch"
  USING (current_setting('app.bypass_rls', true) = 'on')
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on');
