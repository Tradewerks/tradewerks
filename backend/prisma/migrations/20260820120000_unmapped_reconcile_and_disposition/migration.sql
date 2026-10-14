-- Unknown parts: explicit origin, explicit stock disposition, and a terminal
-- state for names that are meant to stay off the catalog.
--
-- Three independent gaps, one migration because the reconcile surface reads all
-- three in a single query:
--
--  1. inventory_item.origin — origin was inferred from created_by_tech_id being
--     NULL, which is why every dispatch quick-add rendered as "Submitted by
--     unknown". The backfill below applies that same inference, so historical
--     rows are APPROXIMATE by construction: a spreadsheet import and a
--     hand-created catalog item both land on dispatch_quick_add. Accepted —
--     nothing recorded the difference at the time, and guessing harder would
--     only make the value look more authoritative than it is.
--
--  2. disposition — a linked visit line's stock effect was implied (deduct from
--     the warehouse), so a vendor-direct part had to be left deliberately
--     UNLINKED to stop the warehouse being deducted for stock that was never in
--     it. Existing linked lines are stamped 'consume', which is exactly what
--     they already did; unlinked lines stay NULL because a freetext line has no
--     stock effect to describe.
--
--  3. unmapped_part_decision — "this name is meant to stay off the catalog".
--     Name-scoped, matching the scope the linkage backfill already acts on.

CREATE TYPE "line_item_disposition" AS ENUM ('consume', 'receive', 'non_stock');

CREATE TYPE "inventory_item_origin" AS ENUM ('tech_submission', 'dispatch_quick_add', 'field_purchase', 'import');

ALTER TABLE "inventory_item"
    ADD COLUMN "origin" "inventory_item_origin" NOT NULL DEFAULT 'dispatch_quick_add';

UPDATE "inventory_item" SET "origin" = 'tech_submission' WHERE "created_by_tech_id" IS NOT NULL;

ALTER TABLE "job_visit_line_item"
    ADD COLUMN "disposition"            "line_item_disposition",
    ADD COLUMN "disposition_location"   "stock_location_type",
    ADD COLUMN "disposition_vehicle_id" TEXT;

ALTER TABLE "recurring_plan_line_item"
    ADD COLUMN "disposition"            "line_item_disposition",
    ADD COLUMN "disposition_location"   "stock_location_type",
    ADD COLUMN "disposition_vehicle_id" TEXT;

-- Pre-migration behaviour, written down. Reading NULL as 'consume' in code
-- keeps rows created by an older deploy behaving identically.
UPDATE "job_visit_line_item"      SET "disposition" = 'consume' WHERE "inventory_item_id" IS NOT NULL;
UPDATE "recurring_plan_line_item" SET "disposition" = 'consume' WHERE "inventory_item_id" IS NOT NULL;

CREATE INDEX "job_visit_line_item_disposition_vehicle_id_idx"
    ON "job_visit_line_item"("disposition_vehicle_id");
CREATE INDEX "recurring_plan_line_item_disposition_vehicle_id_idx"
    ON "recurring_plan_line_item"("disposition_vehicle_id");

ALTER TABLE "job_visit_line_item"
    ADD CONSTRAINT "job_visit_line_item_disposition_vehicle_id_fkey"
    FOREIGN KEY ("disposition_vehicle_id") REFERENCES "vehicle"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "recurring_plan_line_item"
    ADD CONSTRAINT "recurring_plan_line_item_disposition_vehicle_id_fkey"
    FOREIGN KEY ("disposition_vehicle_id") REFERENCES "vehicle"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "unmapped_part_decision" (
    "id"              TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "folded_name"     TEXT NOT NULL,
    "decided_by_id"   TEXT,
    "decided_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason"          TEXT,

    CONSTRAINT "unmapped_part_decision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "unmapped_part_decision_organization_id_folded_name_key"
    ON "unmapped_part_decision"("organization_id", "folded_name");
CREATE INDEX "unmapped_part_decision_organization_id_idx"
    ON "unmapped_part_decision"("organization_id");

ALTER TABLE "unmapped_part_decision"
    ADD CONSTRAINT "unmapped_part_decision_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "unmapped_part_decision"
    ADD CONSTRAINT "unmapped_part_decision_decided_by_id_fkey"
    FOREIGN KEY ("decided_by_id") REFERENCES "dispatcher"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
