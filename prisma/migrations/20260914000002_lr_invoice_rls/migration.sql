-- LrInvoice was created without the tenant-isolation policies every table carries; add them.

ALTER TABLE "LrInvoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LrInvoice" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "LrInvoice";
CREATE POLICY tenant_isolation ON "LrInvoice"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS platform_bypass ON "LrInvoice";
CREATE POLICY platform_bypass ON "LrInvoice"
  USING (current_setting('app.bypass_rls', true) = 'on')
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on');
