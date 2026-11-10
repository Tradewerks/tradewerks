-- AlterTable
ALTER TABLE "invoice" ADD COLUMN     "qb_credit_applied_payment_id" TEXT,
ADD COLUMN     "qb_credit_memo_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "invoice_account_id_qb_credit_memo_id_key" ON "invoice"("account_id", "qb_credit_memo_id");
