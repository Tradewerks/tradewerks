-- Referential integrity and indexes for the dispute cross-references.
-- No column is added, dropped, renamed or retyped.
--
-- replacement_quote_id / replacement_invoice_id / adjustment_invoice_id shipped
-- as bare String? columns, so nothing stopped them pointing at a document that
-- had since been deleted -- a silent dangling id every reader has to defend
-- against. RESTRICT rather than SET NULL or CASCADE: the dispute record is the
-- audit trail, and the document a resolution produced is part of it. SET NULL
-- would keep the row but erase the one field that says what the resolution
-- produced. Deleting such a document is refused in words by deleteQuote, and
-- invoices a resolution produces are never Draft (only Draft invoices are
-- deletable), so the constraint is the backstop rather than the UX.
--
-- Every value in these columns is written by resolveDispute from a document it
-- created in the same transaction, but on a split deploy a document could be
-- deleted between 20260904210133 and this migration. Those ids already dangle,
-- so they are nulled first rather than letting ADD CONSTRAINT abort the deploy
-- on 23503.

UPDATE "document_dispute" d
SET "replacement_quote_id" = NULL
WHERE d."replacement_quote_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "quote" q WHERE q."id" = d."replacement_quote_id");

UPDATE "document_dispute" d
SET "replacement_invoice_id" = NULL
WHERE d."replacement_invoice_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "invoice" i WHERE i."id" = d."replacement_invoice_id");

UPDATE "document_dispute" d
SET "adjustment_invoice_id" = NULL
WHERE d."adjustment_invoice_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "invoice" i WHERE i."id" = d."adjustment_invoice_id");

-- CreateIndex
CREATE INDEX "document_dispute_replacement_quote_id_idx" ON "document_dispute"("replacement_quote_id");

-- CreateIndex
CREATE INDEX "document_dispute_replacement_invoice_id_idx" ON "document_dispute"("replacement_invoice_id");

-- CreateIndex
CREATE INDEX "document_dispute_adjustment_invoice_id_idx" ON "document_dispute"("adjustment_invoice_id");

-- CreateIndex
-- Both columns carry SET NULL foreign keys, so deleting a dispatcher had to
-- sequentially scan document_dispute to null them out.
CREATE INDEX "document_dispute_opened_by_dispatcher_id_idx" ON "document_dispute"("opened_by_dispatcher_id");

-- CreateIndex
CREATE INDEX "document_dispute_resolved_by_dispatcher_id_idx" ON "document_dispute"("resolved_by_dispatcher_id");

-- AddForeignKey
ALTER TABLE "document_dispute" ADD CONSTRAINT "document_dispute_replacement_quote_id_fkey" FOREIGN KEY ("replacement_quote_id") REFERENCES "quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_dispute" ADD CONSTRAINT "document_dispute_replacement_invoice_id_fkey" FOREIGN KEY ("replacement_invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_dispute" ADD CONSTRAINT "document_dispute_adjustment_invoice_id_fkey" FOREIGN KEY ("adjustment_invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Quotes have no equivalent of the invoice adjustment chain, so there is no
-- quote-side adjustment FK to add.
