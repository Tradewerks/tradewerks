-- Field purchase reaches the job it was bought for.
--
-- Until now `field_purchase_job_allocation` was written, displayed, and read by
-- nothing else: an approved purchase produced no job cost and no billable line,
-- so a `non_stock` line - the spec's "Consumed on job", and the typical
-- emergency buy - disappeared on approval. These two columns are what close it.
--
--  1. `job_visit_id` on the allocation. Billing needs a VISIT and the job alone
--     does not name one. The technician is standing on a visit when they buy, so
--     the entry point already knows it. Nullable: a purchase started with no
--     visit in context still allocates to the job, it just cannot bill itself.
--
--  2. `visit_line_item_id` on the line. UNIQUE, so a re-submit settles the row it
--     already created instead of billing the customer a second time. SET NULL on
--     delete: a dispatcher removing the billed line does not take the receipt
--     line with it - the purchase record is the money trail.
--
-- No backfill. Existing allocations have no visit to infer (a job's visits are
-- not interchangeable for billing) and no line has billed anything yet.

ALTER TABLE "field_purchase_job_allocation"
    ADD COLUMN "job_visit_id" TEXT;

ALTER TABLE "field_purchase_job_allocation"
    ADD CONSTRAINT "field_purchase_job_allocation_job_visit_id_fkey"
        FOREIGN KEY ("job_visit_id") REFERENCES "job_visit"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "field_purchase_job_allocation_job_visit_id_idx"
    ON "field_purchase_job_allocation"("job_visit_id");

ALTER TABLE "field_purchase_line"
    ADD COLUMN "visit_line_item_id" TEXT;

ALTER TABLE "field_purchase_line"
    ADD CONSTRAINT "field_purchase_line_visit_line_item_id_fkey"
        FOREIGN KEY ("visit_line_item_id") REFERENCES "job_visit_line_item"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "field_purchase_line_visit_line_item_id_key"
    ON "field_purchase_line"("visit_line_item_id");
