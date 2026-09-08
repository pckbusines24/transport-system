-- AlterEnum
-- Receipt Vouchers settle the party (receivable) side of a broker slip under
-- its own reference type; BROKER_ENTRY stays the owner (payable) side.
ALTER TYPE "ModuleLink" ADD VALUE 'BROKER_SLIP_PARTY';
