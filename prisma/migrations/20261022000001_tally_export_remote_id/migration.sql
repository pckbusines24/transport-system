-- Chalan advance vouchers go to Tally with a REMOTEID: remember that, plus the
-- voucher type and date last sent, so an edit can Alter (or Delete + Create)
ALTER TABLE "TallyExportEntry" ADD COLUMN IF NOT EXISTS "remoteId" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TallyExportEntry" ADD COLUMN IF NOT EXISTS "vchType" TEXT;
ALTER TABLE "TallyExportEntry" ADD COLUMN IF NOT EXISTS "vchDate" TEXT;
