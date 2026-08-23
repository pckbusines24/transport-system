-- Invoice round off made real: the printed whole-rupee rounding is now stored
-- on the bill and posted to the ledger instead of being display-only.
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "roundOff" DECIMAL(12,2) NOT NULL DEFAULT 0;
