-- staff loan recovery can now ride a salary payment voucher (allocation refType)
ALTER TYPE "ModuleLink" ADD VALUE IF NOT EXISTS 'STAFF_LOAN';
-- advances / loans given from the staff screen are Payment Vouchers
ALTER TABLE "StaffAdvance" ADD COLUMN IF NOT EXISTS "voucherId" TEXT;
ALTER TABLE "StaffLoan" ADD COLUMN IF NOT EXISTS "voucherId" TEXT;
