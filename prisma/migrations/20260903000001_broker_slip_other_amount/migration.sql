-- Broker slip gains "Other Amount" on both sides, so the slip carries the same
-- six adjustment fields a chalan already does: Detention, ODC, Fine, Other
-- (additions) and LD Charge, Shortage (deductions).
--
-- These are ADJUSTMENTS, never part of the freight. Purchase/Sale Register's
-- main value stays pFreight / vFreight; adjustments are reported separately.

ALTER TABLE "BrokerSlip" ADD COLUMN IF NOT EXISTS "pOtherAmt" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "BrokerSlip" ADD COLUMN IF NOT EXISTS "vOtherAmt" DECIMAL(12,2) NOT NULL DEFAULT 0;
