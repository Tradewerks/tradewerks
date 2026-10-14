-- Line item ↔ inventory linkage.
--
-- job_visit_line_item, recurring_plan_line_item and invoice_line_item already
-- carry inventory_item_id. quote_line_item and job_line_item did not, so a
-- quote or job could name a part but never point at it — and the link was lost
-- on quote → job conversion even where it existed downstream.
--
-- Reference only on both tables: warehouse consumption stays exclusively in
-- deductInventoryForVisit (visit completion) and the tech parts-used path.
-- ON DELETE SET NULL matches invoice_line_item — deleting a catalog item must
-- not cascade away historical billing rows.

ALTER TABLE "quote_line_item" ADD COLUMN "inventory_item_id" TEXT;
ALTER TABLE "job_line_item"   ADD COLUMN "inventory_item_id" TEXT;

CREATE INDEX "quote_line_item_inventory_item_id_idx"
    ON "quote_line_item"("inventory_item_id");
CREATE INDEX "job_line_item_inventory_item_id_idx"
    ON "job_line_item"("inventory_item_id");

ALTER TABLE "quote_line_item"
    ADD CONSTRAINT "quote_line_item_inventory_item_id_fkey"
    FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_item"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "job_line_item"
    ADD CONSTRAINT "job_line_item_inventory_item_id_fkey"
    FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_item"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
