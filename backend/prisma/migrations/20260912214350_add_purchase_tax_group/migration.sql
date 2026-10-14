-- AlterTable
ALTER TABLE "purchase" ADD COLUMN     "tax_group_id" TEXT;

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_tax_group_id_fkey" FOREIGN KEY ("tax_group_id") REFERENCES "tax_group"("id") ON DELETE SET NULL ON UPDATE CASCADE;
