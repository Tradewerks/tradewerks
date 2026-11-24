-- AlterTable
ALTER TABLE "invoice" ADD COLUMN     "qb_diverged_at" TIMESTAMP(3),
ADD COLUMN     "qb_diverged_reason" TEXT;

-- CreateIndex
CREATE INDEX "invoice_organization_id_qb_diverged_at_idx" ON "invoice"("organization_id", "qb_diverged_at");
