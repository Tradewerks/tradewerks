-- One QuickBooks payment applied to several invoices is stored as one row per
-- invoice. Safe on existing data: the old unique is strictly stronger.

-- DropIndex
DROP INDEX "invoice_payment_account_id_qb_payment_id_key";

-- CreateIndex
CREATE UNIQUE INDEX "invoice_payment_account_id_qb_payment_id_invoice_id_key" ON "invoice_payment"("account_id", "qb_payment_id", "invoice_id");
