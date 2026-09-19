-- Document numbers: unique among ACTIVE (non-deleted) rows only, so the
-- number of a soft-deleted chalan / slip / voucher / bill can be reused.
-- Mirrors the earlier Lr and Invoice partial-unique migrations.

DROP INDEX IF EXISTS "Chalan_firmId_fyId_chalanNo_key";
CREATE INDEX IF NOT EXISTS "Chalan_firmId_fyId_chalanNo_idx" ON "Chalan"("firmId", "fyId", "chalanNo");
CREATE UNIQUE INDEX IF NOT EXISTS "Chalan_firmId_fyId_chalanNo_active_key"
  ON "Chalan"("firmId", "fyId", "chalanNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "LoadingChalan_firmId_fyId_chalanNo_key";
CREATE INDEX IF NOT EXISTS "LoadingChalan_firmId_fyId_chalanNo_idx" ON "LoadingChalan"("firmId", "fyId", "chalanNo");
CREATE UNIQUE INDEX IF NOT EXISTS "LoadingChalan_firmId_fyId_chalanNo_active_key"
  ON "LoadingChalan"("firmId", "fyId", "chalanNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "Delivery_firmId_fyId_delNo_key";
CREATE INDEX IF NOT EXISTS "Delivery_firmId_fyId_delNo_idx" ON "Delivery"("firmId", "fyId", "delNo");
CREATE UNIQUE INDEX IF NOT EXISTS "Delivery_firmId_fyId_delNo_active_key"
  ON "Delivery"("firmId", "fyId", "delNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "Crossing_firmId_fyId_chalanNo_key";
CREATE INDEX IF NOT EXISTS "Crossing_firmId_fyId_chalanNo_idx" ON "Crossing"("firmId", "fyId", "chalanNo");
CREATE UNIQUE INDEX IF NOT EXISTS "Crossing_firmId_fyId_chalanNo_active_key"
  ON "Crossing"("firmId", "fyId", "chalanNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "OutwardCrossing_firmId_fyId_ocNo_key";
CREATE INDEX IF NOT EXISTS "OutwardCrossing_firmId_fyId_ocNo_idx" ON "OutwardCrossing"("firmId", "fyId", "ocNo");
CREATE UNIQUE INDEX IF NOT EXISTS "OutwardCrossing_firmId_fyId_ocNo_active_key"
  ON "OutwardCrossing"("firmId", "fyId", "ocNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "HireSlip_firmId_fyId_slipNo_key";
CREATE INDEX IF NOT EXISTS "HireSlip_firmId_fyId_slipNo_idx" ON "HireSlip"("firmId", "fyId", "slipNo");
CREATE UNIQUE INDEX IF NOT EXISTS "HireSlip_firmId_fyId_slipNo_active_key"
  ON "HireSlip"("firmId", "fyId", "slipNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "SettlementSummary_firmId_fyId_summaryNo_key";
CREATE INDEX IF NOT EXISTS "SettlementSummary_firmId_fyId_summaryNo_idx" ON "SettlementSummary"("firmId", "fyId", "summaryNo");
CREATE UNIQUE INDEX IF NOT EXISTS "SettlementSummary_firmId_fyId_summaryNo_active_key"
  ON "SettlementSummary"("firmId", "fyId", "summaryNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "StaffAdvance_firmId_fyId_advanceNo_key";
CREATE INDEX IF NOT EXISTS "StaffAdvance_firmId_fyId_advanceNo_idx" ON "StaffAdvance"("firmId", "fyId", "advanceNo");
CREATE UNIQUE INDEX IF NOT EXISTS "StaffAdvance_firmId_fyId_advanceNo_active_key"
  ON "StaffAdvance"("firmId", "fyId", "advanceNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "StaffLoan_firmId_fyId_loanNo_key";
CREATE INDEX IF NOT EXISTS "StaffLoan_firmId_fyId_loanNo_idx" ON "StaffLoan"("firmId", "fyId", "loanNo");
CREATE UNIQUE INDEX IF NOT EXISTS "StaffLoan_firmId_fyId_loanNo_active_key"
  ON "StaffLoan"("firmId", "fyId", "loanNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "OfficeTransaction_firmId_fyId_voucherNo_key";
CREATE INDEX IF NOT EXISTS "OfficeTransaction_firmId_fyId_voucherNo_idx" ON "OfficeTransaction"("firmId", "fyId", "voucherNo");
CREATE UNIQUE INDEX IF NOT EXISTS "OfficeTransaction_firmId_fyId_voucherNo_active_key"
  ON "OfficeTransaction"("firmId", "fyId", "voucherNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "Voucher_firmId_fyId_type_voucherNo_key";
CREATE INDEX IF NOT EXISTS "Voucher_firmId_fyId_type_voucherNo_idx" ON "Voucher"("firmId", "fyId", "type", "voucherNo");
CREATE UNIQUE INDEX IF NOT EXISTS "Voucher_firmId_fyId_type_voucherNo_active_key"
  ON "Voucher"("firmId", "fyId", "type", "voucherNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "BrokerSlip_firmId_fyId_slipNo_key";
CREATE INDEX IF NOT EXISTS "BrokerSlip_firmId_fyId_slipNo_idx" ON "BrokerSlip"("firmId", "fyId", "slipNo");
CREATE UNIQUE INDEX IF NOT EXISTS "BrokerSlip_firmId_fyId_slipNo_active_key"
  ON "BrokerSlip"("firmId", "fyId", "slipNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "Trip_firmId_fyId_tripNo_key";
CREATE INDEX IF NOT EXISTS "Trip_firmId_fyId_tripNo_idx" ON "Trip"("firmId", "fyId", "tripNo");
CREATE UNIQUE INDEX IF NOT EXISTS "Trip_firmId_fyId_tripNo_active_key"
  ON "Trip"("firmId", "fyId", "tripNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "Loan_firmId_fyId_loanNo_key";
CREATE INDEX IF NOT EXISTS "Loan_firmId_fyId_loanNo_idx" ON "Loan"("firmId", "fyId", "loanNo");
CREATE UNIQUE INDEX IF NOT EXISTS "Loan_firmId_fyId_loanNo_active_key"
  ON "Loan"("firmId", "fyId", "loanNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "FinanceTxn_firmId_fyId_voucherNo_key";
CREATE INDEX IF NOT EXISTS "FinanceTxn_firmId_fyId_voucherNo_idx" ON "FinanceTxn"("firmId", "fyId", "voucherNo");
CREATE UNIQUE INDEX IF NOT EXISTS "FinanceTxn_firmId_fyId_voucherNo_active_key"
  ON "FinanceTxn"("firmId", "fyId", "voucherNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "JobEntry_firmId_fyId_invoiceNo_key";
CREATE INDEX IF NOT EXISTS "JobEntry_firmId_fyId_invoiceNo_idx" ON "JobEntry"("firmId", "fyId", "invoiceNo");
CREATE UNIQUE INDEX IF NOT EXISTS "JobEntry_firmId_fyId_invoiceNo_active_key"
  ON "JobEntry"("firmId", "fyId", "invoiceNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "Purchase_firmId_fyId_kind_invoiceNo_key";
CREATE INDEX IF NOT EXISTS "Purchase_firmId_fyId_kind_invoiceNo_idx" ON "Purchase"("firmId", "fyId", "kind", "invoiceNo");
CREATE UNIQUE INDEX IF NOT EXISTS "Purchase_firmId_fyId_kind_invoiceNo_active_key"
  ON "Purchase"("firmId", "fyId", "kind", "invoiceNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "CourierDispatch_firmId_fyId_dispatchNo_key";
CREATE INDEX IF NOT EXISTS "CourierDispatch_firmId_fyId_dispatchNo_idx" ON "CourierDispatch"("firmId", "fyId", "dispatchNo");
CREATE UNIQUE INDEX IF NOT EXISTS "CourierDispatch_firmId_fyId_dispatchNo_active_key"
  ON "CourierDispatch"("firmId", "fyId", "dispatchNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "SparePart_tenantId_firmId_serialNo_key";
CREATE INDEX IF NOT EXISTS "SparePart_tenantId_firmId_serialNo_idx" ON "SparePart"("tenantId", "firmId", "serialNo");
CREATE UNIQUE INDEX IF NOT EXISTS "SparePart_tenantId_firmId_serialNo_active_key"
  ON "SparePart"("tenantId", "firmId", "serialNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "VehicleExpenseVoucher_firmId_fyId_voucherNo_key";
CREATE INDEX IF NOT EXISTS "VehicleExpenseVoucher_firmId_fyId_voucherNo_idx" ON "VehicleExpenseVoucher"("firmId", "fyId", "voucherNo");
CREATE UNIQUE INDEX IF NOT EXISTS "VehicleExpenseVoucher_firmId_fyId_voucherNo_active_key"
  ON "VehicleExpenseVoucher"("firmId", "fyId", "voucherNo")
  WHERE "deletedAt" IS NULL;

DROP INDEX IF EXISTS "DriverFnf_firmId_fyId_settlementNo_key";
CREATE INDEX IF NOT EXISTS "DriverFnf_firmId_fyId_settlementNo_idx" ON "DriverFnf"("firmId", "fyId", "settlementNo");
CREATE UNIQUE INDEX IF NOT EXISTS "DriverFnf_firmId_fyId_settlementNo_active_key"
  ON "DriverFnf"("firmId", "fyId", "settlementNo")
  WHERE "deletedAt" IS NULL;
