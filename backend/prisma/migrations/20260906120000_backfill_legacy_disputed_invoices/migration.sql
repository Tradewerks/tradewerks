-- Data-only backfill. No schema change.
--
-- Before this work, an invoice reached 'Disputed' through a bare status flag
-- ("Mark as Disputed") that recorded no reason, no actor and no outcome. That
-- button is gone (spec section 8), and resolution now lives on the dispute
-- banner, which needs a document_dispute row to render. An invoice already
-- sitting at 'Disputed' with no row would therefore have no resolve path at
-- all: Open Dispute is gated off because the status is not one of
-- Sent/Viewed/PartiallyPaid/Paid, no banner appears, and Void becomes the only
-- remaining action -- which on an invoice holding payment strands the money
-- that spec section 4 / D8 exists to protect.
--
-- Opening a real dispute row for each of them restores the full outcome set
-- (Revise & Resend, Issue Adjustment, Repeal), correctly gated by amount_paid.
--
-- The old flag did not record the pre-dispute status, so status_at_open is
-- inferred from the delivery evidence on the row itself: viewed_at, then
-- sent_at, else the invoice was only ever Issued (delivered by hand). This
-- matters because resolving the dispute writes status_at_open back as the
-- invoice's real status; a blanket 'Sent' would give a hand-delivered invoice
-- a Sent badge with no sent_at. All three are legal exits from Disputed. An
-- invoice holding payments still ends up right: syncInvoicePaymentTotals
-- recomputes PartiallyPaid/Paid from the payment rows after the restore.
--
-- reason is internal (spec section 11) and never reaches a client PDF or the
-- send-to-client payload, so it states plainly what happened rather than
-- inventing a client-facing grievance.
--
-- No opener is attributed: the old flag stored no actor and this row is written
-- by a migration, not a dispatcher. opened_by_dispatcher_id is nullable.
--
-- Scoped to invoices only. 'Disputed' was added to quote_status by
-- 20260904210133_document_dispute, so no quote predates the dispute row.
--
-- The NOT EXISTS guard makes this idempotent and keeps it from colliding with
-- the "dispute_one_open_per_invoice" partial unique index.

INSERT INTO "document_dispute" (
    "id",
    "organization_id",
    "document_kind",
    "invoice_id",
    "status",
    "reason",
    "status_at_open",
    "opened_at"
)
SELECT
    gen_random_uuid()::text,
    i."organization_id",
    'invoice'::"document_kind",
    i."id",
    'Open'::"dispute_status",
    'Migrated from the previous Disputed status flag, which recorded no reason, no actor and no outcome. Resolve this dispute to choose how the invoice is corrected.',
    CASE
        WHEN i."viewed_at" IS NOT NULL THEN 'Viewed'
        WHEN i."sent_at" IS NOT NULL THEN 'Sent'
        ELSE 'Issued'
    END,
    CURRENT_TIMESTAMP
FROM "invoice" i
WHERE i."status" = 'Disputed'
  AND NOT EXISTS (
      SELECT 1
      FROM "document_dispute" d
      WHERE d."invoice_id" = i."id"
        AND d."status" = 'Open'
  );
