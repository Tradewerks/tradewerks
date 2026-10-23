ALTER TYPE "qb_sync_status" ADD VALUE IF NOT EXISTS 'tax_mismatch';
ALTER TABLE "organization" ADD COLUMN "qb_passthrough_tax_code_id" TEXT;
ALTER TABLE "invoice" ADD COLUMN "qb_tax_amount" DECIMAL(10,2);
