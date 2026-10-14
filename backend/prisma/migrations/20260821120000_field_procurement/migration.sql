-- Emergency field procurement: a technician buys a part at a counter mid-job,
-- pays out of pocket, and submits the receipt for dispatcher review.
--
-- Five new tables and one new column, no backfill: nothing in the database today
-- describes a field purchase, so there is no prior behaviour to write down.
--
-- Two reuses worth naming, because they are why this migration is small:
--
--  1. `line_item_disposition` is reused on field_purchase_line rather than a new
--     receipt-specific enum. A receipt line IS a line item with an optional
--     catalog link and a disposition. Only 'receive' and 'non_stock' are legal
--     there - 'consume' would claim a field-bought part came off our own shelf -
--     and that is enforced in validation, not by a CHECK, so the constraint sits
--     next to the message the technician reads.
--
--  2. stock_movement gains only a source ref. The approve-time intake reuses
--     reason 'supplier_purchase', which already names this exact physical event
--     (a tech buying at a counter), so the ledger keeps one vocabulary.

CREATE TYPE "field_purchase_status" AS ENUM (
    'draft',
    'pending_preauth',
    'preauth_denied',
    'preauth_approved',
    'pending_review',
    'queried',
    'approved',
    'rejected'
);

-- Authority to buy is per-technician and revocable, not a role: the role
-- permission only gates reaching the flow, these limits bound the money.
CREATE TABLE "field_purchase_grant" (
    "id"                    TEXT NOT NULL,
    "organization_id"       TEXT NOT NULL,
    "technician_id"         TEXT NOT NULL,
    "per_transaction_limit" DECIMAL(10,2) NOT NULL,
    "daily_limit"           DECIMAL(10,2),
    "weekly_limit"          DECIMAL(10,2),
    "per_job_limit"         DECIMAL(10,2),
    "is_active"             BOOLEAN NOT NULL DEFAULT true,
    "granted_by_id"         TEXT,
    "granted_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_by_id"         TEXT,
    "revoked_at"            TIMESTAMP(3),
    "notes"                 TEXT,
    "updated_at"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "field_purchase_grant_pkey" PRIMARY KEY ("id")
);

-- One row per tech; grant/revoke history lives in field_purchase_event instead
-- of a pile of superseded rows.
CREATE UNIQUE INDEX "field_purchase_grant_organization_id_technician_id_key"
    ON "field_purchase_grant"("organization_id", "technician_id");
CREATE INDEX "field_purchase_grant_organization_id_is_active_idx"
    ON "field_purchase_grant"("organization_id", "is_active");

CREATE TABLE "field_purchase" (
    "id"                   TEXT NOT NULL,
    "organization_id"      TEXT NOT NULL,
    "technician_id"        TEXT NOT NULL,
    "status"               "field_purchase_status" NOT NULL DEFAULT 'draft',
    "reason"               TEXT,
    "estimated_amount"     DECIMAL(10,2),
    "vendor_name"          TEXT,
    "supplier_id"          TEXT,
    "purchased_at"         TIMESTAMP(3),
    "subtotal"             DECIMAL(10,2) NOT NULL DEFAULT 0,
    "tax_amount"           DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total"                DECIMAL(10,2) NOT NULL DEFAULT 0,
    "receipt_image_url"    TEXT,
    "receipt_image_hash"   TEXT,
    "captured_at"          TIMESTAMP(3),
    "capture_lat"          DECIMAL(9,6),
    "capture_lng"          DECIMAL(9,6),
    "capture_accuracy_m"   INTEGER,
    "submitted_at"         TIMESTAMP(3),
    "preauth_requested_at" TIMESTAMP(3),
    "preauth_decided_at"   TIMESTAMP(3),
    "preauth_by_id"        TEXT,
    "preauth_note"         TEXT,
    "reviewed_at"          TIMESTAMP(3),
    "reviewed_by_id"       TEXT,
    "review_note"          TEXT,
    "flags"                JSONB NOT NULL DEFAULT '[]',
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "field_purchase_pkey" PRIMARY KEY ("id")
);

-- Receipt reuse is the primary fraud vector in a reimbursement model: there is
-- no independent upstream record of the purchase, so the image is the only
-- proof. Scoped per organization, since two orgs can hold the same file
-- legitimately. Postgres treats NULLs as distinct, so drafts with no receipt yet
-- do not collide.
CREATE UNIQUE INDEX "field_purchase_organization_id_receipt_image_hash_key"
    ON "field_purchase"("organization_id", "receipt_image_hash");
CREATE INDEX "field_purchase_organization_id_status_idx"
    ON "field_purchase"("organization_id", "status");
CREATE INDEX "field_purchase_organization_id_technician_id_purchased_at_idx"
    ON "field_purchase"("organization_id", "technician_id", "purchased_at");

CREATE TABLE "field_purchase_line" (
    "id"                     TEXT NOT NULL,
    "field_purchase_id"      TEXT NOT NULL,
    "description"            TEXT NOT NULL,
    "quantity"               DECIMAL(10,2) NOT NULL,
    "unit_price"             DECIMAL(10,2) NOT NULL,
    "line_total"             DECIMAL(10,2) NOT NULL,
    "inventory_item_id"      TEXT,
    "disposition"            "line_item_disposition",
    "disposition_location"   "stock_location_type",
    "disposition_vehicle_id" TEXT,
    "verified_at"            TIMESTAMP(3),
    "sort_order"             INTEGER NOT NULL DEFAULT 0,
    "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "field_purchase_line_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "field_purchase_line_field_purchase_id_idx"
    ON "field_purchase_line"("field_purchase_id");
CREATE INDEX "field_purchase_line_inventory_item_id_idx"
    ON "field_purchase_line"("inventory_item_id");
CREATE INDEX "field_purchase_line_disposition_vehicle_id_idx"
    ON "field_purchase_line"("disposition_vehicle_id");

-- Split by amount rather than percentage: amounts are what finance reconciles,
-- and a percentage re-derives a different cent on every read.
CREATE TABLE "field_purchase_job_allocation" (
    "id"                TEXT NOT NULL,
    "field_purchase_id" TEXT NOT NULL,
    "job_id"            TEXT NOT NULL,
    "amount"            DECIMAL(10,2) NOT NULL,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_purchase_job_allocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "field_purchase_job_allocation_field_purchase_id_job_id_key"
    ON "field_purchase_job_allocation"("field_purchase_id", "job_id");
CREATE INDEX "field_purchase_job_allocation_job_id_idx"
    ON "field_purchase_job_allocation"("job_id");

-- Append-only: a correction is another row. Grants and purchases share the table
-- so one query answers "what happened to this technician's authority and spend".
CREATE TABLE "field_purchase_event" (
    "id"                TEXT NOT NULL,
    "organization_id"   TEXT NOT NULL,
    "field_purchase_id" TEXT,
    "grant_id"          TEXT,
    "type"              TEXT NOT NULL,
    "actor_type"        TEXT NOT NULL,
    "actor_id"          TEXT,
    "detail"            JSONB NOT NULL DEFAULT '{}',
    "at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_purchase_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "field_purchase_event_organization_id_at_idx"
    ON "field_purchase_event"("organization_id", "at");
CREATE INDEX "field_purchase_event_field_purchase_id_at_idx"
    ON "field_purchase_event"("field_purchase_id", "at");
CREATE INDEX "field_purchase_event_grant_id_at_idx"
    ON "field_purchase_event"("grant_id", "at");

ALTER TABLE "stock_movement"
    ADD COLUMN "field_purchase_line_id" TEXT;

CREATE INDEX "stock_movement_field_purchase_line_id_idx"
    ON "stock_movement"("field_purchase_line_id");

ALTER TABLE "field_purchase_grant"
    ADD CONSTRAINT "field_purchase_grant_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "field_purchase_grant"
    ADD CONSTRAINT "field_purchase_grant_technician_id_fkey"
    FOREIGN KEY ("technician_id") REFERENCES "technician"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "field_purchase_grant"
    ADD CONSTRAINT "field_purchase_grant_granted_by_id_fkey"
    FOREIGN KEY ("granted_by_id") REFERENCES "dispatcher"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "field_purchase_grant"
    ADD CONSTRAINT "field_purchase_grant_revoked_by_id_fkey"
    FOREIGN KEY ("revoked_by_id") REFERENCES "dispatcher"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "field_purchase"
    ADD CONSTRAINT "field_purchase_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT, not CASCADE: deleting a technician must not silently delete the
-- money trail for purchases they already submitted.
ALTER TABLE "field_purchase"
    ADD CONSTRAINT "field_purchase_technician_id_fkey"
    FOREIGN KEY ("technician_id") REFERENCES "technician"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "field_purchase"
    ADD CONSTRAINT "field_purchase_supplier_id_fkey"
    FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "field_purchase"
    ADD CONSTRAINT "field_purchase_preauth_by_id_fkey"
    FOREIGN KEY ("preauth_by_id") REFERENCES "dispatcher"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "field_purchase"
    ADD CONSTRAINT "field_purchase_reviewed_by_id_fkey"
    FOREIGN KEY ("reviewed_by_id") REFERENCES "dispatcher"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "field_purchase_line"
    ADD CONSTRAINT "field_purchase_line_field_purchase_id_fkey"
    FOREIGN KEY ("field_purchase_id") REFERENCES "field_purchase"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, matching every other line-item link: deleting a catalog item
-- unmaps the line, it does not erase what was bought.
ALTER TABLE "field_purchase_line"
    ADD CONSTRAINT "field_purchase_line_inventory_item_id_fkey"
    FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_item"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "field_purchase_line"
    ADD CONSTRAINT "field_purchase_line_disposition_vehicle_id_fkey"
    FOREIGN KEY ("disposition_vehicle_id") REFERENCES "vehicle"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "field_purchase_job_allocation"
    ADD CONSTRAINT "field_purchase_job_allocation_field_purchase_id_fkey"
    FOREIGN KEY ("field_purchase_id") REFERENCES "field_purchase"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "field_purchase_job_allocation"
    ADD CONSTRAINT "field_purchase_job_allocation_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "job"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "field_purchase_event"
    ADD CONSTRAINT "field_purchase_event_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- CASCADE here despite the append-only rule: a DRAFT purchase can be deleted
-- before it ever carries money, and its events go with it. Anything submitted is
-- never deleted, so the trail that matters survives.
ALTER TABLE "field_purchase_event"
    ADD CONSTRAINT "field_purchase_event_field_purchase_id_fkey"
    FOREIGN KEY ("field_purchase_id") REFERENCES "field_purchase"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "field_purchase_event"
    ADD CONSTRAINT "field_purchase_event_grant_id_fkey"
    FOREIGN KEY ("grant_id") REFERENCES "field_purchase_grant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stock_movement"
    ADD CONSTRAINT "stock_movement_field_purchase_line_id_fkey"
    FOREIGN KEY ("field_purchase_line_id") REFERENCES "field_purchase_line"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
