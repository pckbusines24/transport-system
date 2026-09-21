-- per-LR consignor / consignee address override (master untouched)
ALTER TABLE "Lr" ADD COLUMN IF NOT EXISTS "consignorAddress" TEXT;
ALTER TABLE "Lr" ADD COLUMN IF NOT EXISTS "consigneeAddress" TEXT;
