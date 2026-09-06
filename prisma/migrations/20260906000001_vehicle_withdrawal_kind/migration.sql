-- Owner Deposit: the mirror of Owner Withdrawal. Same table, a `kind` column
-- tells the two apart. Existing rows are all withdrawals.
ALTER TABLE "VehicleWithdrawal" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'WITHDRAWAL';
