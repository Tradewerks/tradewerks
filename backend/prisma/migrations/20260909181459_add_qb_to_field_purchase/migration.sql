/*
  Warnings:

  - A unique constraint covering the columns `[account_id,qb_purchase_id]` on the table `field_purchase` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "field_purchase" ADD COLUMN     "account_id" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "qb_purchase_id" TEXT,
ADD COLUMN     "qb_sync_status" "qb_sync_status" NOT NULL DEFAULT 'not_synced';

-- CreateIndex
CREATE UNIQUE INDEX "field_purchase_account_id_qb_purchase_id_key" ON "field_purchase"("account_id", "qb_purchase_id");
