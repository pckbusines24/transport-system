-- AlterEnum: driver salary payments are Payment Vouchers allocated under their own type
ALTER TYPE "ModuleLink" ADD VALUE IF NOT EXISTS 'DRIVER_SALARY';
