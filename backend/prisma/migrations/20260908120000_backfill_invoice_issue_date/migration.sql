-- Data-only backfill. No schema change.
--
-- issue_date used to be stamped only on the transition to 'Sent'
-- (invoicesController.updateInvoice). Creation leaves it NULL unless a caller
-- passes one, and syncInvoicePaymentTotals writes the payment-derived status
-- directly without touching it.
--
-- But 'Sent' is only one of two delivery doors. 'Issued' is the other: the
-- business marks the invoice issued and delivers the PDF itself (downloads it,
-- hands it over, sends it from its own mail). Those invoices left Draft, are
-- real receivables, and never passed through 'Sent' -- so they kept
-- issue_date IS NULL forever, and an Issued invoice that then took a payment
-- was promoted straight to PartiallyPaid/Paid still carrying NULL.
--
-- That is not cosmetic. Six report queries date invoice revenue as
--     OR: [{ issue_date: <window> }, { issue_date: null, created_at: <window> }]
-- (reportsController.ts:1674, 2102, 2286, 2957, 3743, 3980), so a NULL
-- issue_date silently dates the revenue to WHEN THE DRAFT WAS FIRST OPENED --
-- potentially a different month or quarter than the invoice was issued in.
-- InvoiceDetailPage prints the same fallback as "Issued <date>", so the page
-- displayed a creation date under an issued label.
--
-- updateInvoice now stamps issue_date on whichever door the invoice leaves
-- Draft through (see isInvoiceFinalizingTransition in lib/statusTransitions.ts).
-- This fixes the rows that predate that.
--
-- Aged receivables was never affected and is not touched here: it ages on
-- COALESCE(due_date, created_at) and filters on status, not on issue_date.
--
-- Predicate is evidence-based rather than status-based: only rows that
-- PROVABLY left Draft are backfilled. issued_at is stamped on the Issued door
-- and sent_at on the Sent door, so requiring one of them means a genuine Draft
-- is never given a date, and neither is a draft that was voided without ever
-- being issued. Because one of the two is non-NULL by that guard, the COALESCE
-- always resolves and no created_at fallback is needed.
--
-- issued_at is preferred over sent_at: it is the earlier event and the moment
-- the tax basis was frozen, which is the date the document was committed to.
--
-- Idempotent: it only writes where issue_date IS NULL, so re-running is a
-- no-op, and it never overwrites a date already set -- including the TxnDate
-- carried by invoices imported from QuickBooks.

-- This is a restatement. Moving an invoice from the created_at fallback to
-- its issue_date moves its revenue into the period it was issued in (drafted
-- 2025-12-28, issued 2026-01-03: December -> January), including periods that
-- may already have been reported or exported. The affected rows are snapshotted
-- first so the restatement is recorded, not silent. The snapshot lives in its
-- own schema because Prisma diffs only "public": a table there, absent from
-- schema.prisma, would be dropped by the next generated migration. IF NOT
-- EXISTS keeps the first run's snapshot if this file is ever re-run.
--
-- Lock window: one UPDATE, holding row locks on the backfilled invoices (only
-- rows with a NULL issue_date that provably left Draft) until the migration
-- commits. Batching it in a DO loop would not shorten that: Prisma sends the
-- file as one implicit transaction, in which a DO block cannot COMMIT between
-- batches.

CREATE SCHEMA IF NOT EXISTS "migration_audit";

CREATE TABLE IF NOT EXISTS "migration_audit"."invoice_issue_date_backfill_20260908" AS
SELECT
    "id",
    "organization_id",
    "invoice_number",
    "status",
    "total",
    "created_at",
    "issued_at",
    "sent_at",
    COALESCE("issued_at", "sent_at") AS "backfilled_issue_date",
    CURRENT_TIMESTAMP AS "snapshotted_at"
FROM "invoice"
WHERE "issue_date" IS NULL
  AND ("issued_at" IS NOT NULL OR "sent_at" IS NOT NULL);

UPDATE "invoice"
SET "issue_date" = COALESCE("issued_at", "sent_at")
WHERE "issue_date" IS NULL
  AND ("issued_at" IS NOT NULL OR "sent_at" IS NOT NULL);
