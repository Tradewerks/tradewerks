-- A receipt line names the job it served.
--
-- Job shares lived on the purchase as amounts somebody typed, and the lines
-- underneath knew nothing about who they were for. Everything downstream fell in
-- that gap: `syncBilledLines` refused to bill anything the moment a receipt
-- covered two jobs, so a technician could split a receipt, have it approved, and
-- neither customer would be charged.
--
-- `allocation_id`, not `job_id`: the allocation already carries the `job_visit_id`
-- billing needs, and a second copy of the job is a second thing to keep in step.
--
-- With this, an allocation's `amount` stops being an input and becomes the sum of
-- its lines plus their pro-rata share of the tax.

ALTER TABLE "field_purchase_line"
    ADD COLUMN "allocation_id" TEXT;

ALTER TABLE "field_purchase_line"
    ADD CONSTRAINT "field_purchase_line_allocation_id_fkey"
        FOREIGN KEY ("allocation_id") REFERENCES "field_purchase_job_allocation"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "field_purchase_line_allocation_id_idx"
    ON "field_purchase_line"("allocation_id");

-- Backfill: where a purchase has exactly one allocation, every one of its lines
-- served that job by definition - there was nowhere else for it to go. A purchase
-- with several is left NULL rather than guessed at; a purchase with none already
-- bills nothing and is already flagged.
UPDATE "field_purchase_line" l
SET "allocation_id" = a."id"
FROM "field_purchase_job_allocation" a
WHERE a."field_purchase_id" = l."field_purchase_id"
  AND (
      SELECT COUNT(*) FROM "field_purchase_job_allocation" x
      WHERE x."field_purchase_id" = l."field_purchase_id"
  ) = 1;
