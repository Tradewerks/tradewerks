-- AlterTable
ALTER TABLE "inventory_item" ADD COLUMN     "taxable" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "qb_taxable_item_id" TEXT,
ADD COLUMN     "qb_taxable_item_realm_id" TEXT;
