-- Stage C: OCR extraction for field purchase receipts.
--
-- Additive only. Every column is nullable or defaulted, and `not_run` is the
-- default status, so every row written by Stage B stays valid and reads as
-- "no extraction was attempted" rather than "extraction failed".
--
-- `skipped` exists because no provider configured is a supported end state, not
-- an error: the technician types the receipt in by hand, which the spec requires
-- as the OCR-fail fallback regardless.

CREATE TYPE "field_purchase_ocr_status" AS ENUM (
    'not_run',
    'skipped',
    'pending',
    'succeeded',
    'failed'
);

ALTER TABLE "field_purchase"
    ADD COLUMN "ocr_status"           "field_purchase_ocr_status" NOT NULL DEFAULT 'not_run',
    ADD COLUMN "ocr_provider"         TEXT,
    -- The provider payload exactly as returned: a disputed line has to be
    -- answerable against what the vendor actually sent.
    ADD COLUMN "ocr_raw"              JSONB,
    ADD COLUMN "ocr_field_confidence" JSONB NOT NULL DEFAULT '{}',
    -- Snapshot of the extracted lines. Editing replaces the whole line set, so
    -- this is the only thing left to diff the corrections against at submit.
    ADD COLUMN "ocr_lines"            JSONB,
    ADD COLUMN "ocr_completed_at"     TIMESTAMP(3),
    ADD COLUMN "ocr_error"            TEXT,
    ADD COLUMN "ocr_line_count"       INTEGER,
    ADD COLUMN "ocr_corrections"      INTEGER;

-- Null on any technician-entered line, which after an edit is every line in the
-- replaced set.
ALTER TABLE "field_purchase_line"
    ADD COLUMN "ocr_confidence" DECIMAL(4,3);
