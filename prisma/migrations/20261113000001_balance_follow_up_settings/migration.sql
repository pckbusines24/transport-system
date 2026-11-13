-- Balance Paid Follow-up settings, per firm. Additive with defaults: every
-- existing firm starts enabled at 15 days; no existing data changes.
ALTER TABLE "Firm" ADD COLUMN IF NOT EXISTS "balanceFollowUpEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Firm" ADD COLUMN IF NOT EXISTS "balanceFollowUpDays" INTEGER NOT NULL DEFAULT 15;
