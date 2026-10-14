-- Requires PostgreSQL 12 or later: ALTER TYPE ... ADD VALUE below runs inside
-- the migration's transaction, which PostgreSQL 11 and earlier refuse. The new
-- 'Disputed' value is not used by any later statement in this file, which is
-- the other half of that rule.

-- CreateEnum
CREATE TYPE "document_kind" AS ENUM ('quote', 'invoice');

-- CreateEnum
CREATE TYPE "dispute_status" AS ENUM ('Open', 'Resolved');

-- CreateEnum
CREATE TYPE "dispute_resolution" AS ENUM ('ReviseAndResend', 'IssueAdjustment', 'Repeal');

-- AlterEnum
ALTER TYPE "quote_status" ADD VALUE 'Disputed' BEFORE 'Rejected';

-- CreateTable
CREATE TABLE "document_dispute" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "document_kind" "document_kind" NOT NULL,
    "quote_id" TEXT,
    "invoice_id" TEXT,
    "status" "dispute_status" NOT NULL DEFAULT 'Open',
    "reason" TEXT NOT NULL,
    "contested_line_item_ids" JSONB,
    "status_at_open" TEXT NOT NULL,
    "opened_by_dispatcher_id" TEXT,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolution" "dispute_resolution",
    "resolution_note" TEXT,
    "resolved_by_dispatcher_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "replacement_quote_id" TEXT,
    "replacement_invoice_id" TEXT,
    "adjustment_invoice_id" TEXT,

    CONSTRAINT "document_dispute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_dispute_organization_id_status_idx" ON "document_dispute"("organization_id", "status");

-- CreateIndex
CREATE INDEX "document_dispute_quote_id_idx" ON "document_dispute"("quote_id");

-- CreateIndex
CREATE INDEX "document_dispute_invoice_id_idx" ON "document_dispute"("invoice_id");

-- AddForeignKey
ALTER TABLE "document_dispute" ADD CONSTRAINT "document_dispute_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_dispute" ADD CONSTRAINT "document_dispute_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_dispute" ADD CONSTRAINT "document_dispute_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_dispute" ADD CONSTRAINT "document_dispute_opened_by_dispatcher_id_fkey" FOREIGN KEY ("opened_by_dispatcher_id") REFERENCES "dispatcher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_dispute" ADD CONSTRAINT "document_dispute_resolved_by_dispatcher_id_fkey" FOREIGN KEY ("resolved_by_dispatcher_id") REFERENCES "dispatcher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Exactly one document per dispute, and it is the one document_kind names.
-- Every reader keys on document_kind, so a row whose kind disagrees with its
-- populated column would be invisible on one document and mislabelled on the
-- other.
ALTER TABLE "document_dispute" ADD CONSTRAINT "dispute_exactly_one_document"
  CHECK (
    (document_kind = 'quote' AND quote_id IS NOT NULL AND invoice_id IS NULL)
    OR (document_kind = 'invoice' AND invoice_id IS NOT NULL AND quote_id IS NULL)
  );

-- A Resolved dispute says how and when; an Open one has said neither yet.
ALTER TABLE "document_dispute" ADD CONSTRAINT "dispute_resolution_matches_status"
  CHECK (
    (status = 'Open' AND resolution IS NULL AND resolved_at IS NULL)
    OR (status = 'Resolved' AND resolution IS NOT NULL AND resolved_at IS NOT NULL)
  );

-- At most one Open dispute per document. This, not the application check, is the enforcement.
CREATE UNIQUE INDEX "dispute_one_open_per_quote"
  ON "document_dispute"(quote_id) WHERE status = 'Open';
CREATE UNIQUE INDEX "dispute_one_open_per_invoice"
  ON "document_dispute"(invoice_id) WHERE status = 'Open';
