-- Links an emergency purchase to a known supplier when the receipt identifies one.
--
-- The column and its FK were created by 20260821120000_field_procurement as part
-- of the initial field_purchase table, with ON DELETE RESTRICT and no index,
-- because the code that resolves supplier_id did not exist yet. This migration
-- depends on that one having run first; it corrects the FK to SET NULL and
-- supplies the missing index. Nullable and SET NULL on delete: retiring a
-- supplier must not erase purchase history.
ALTER TABLE "field_purchase" DROP CONSTRAINT IF EXISTS "field_purchase_supplier_id_fkey";

ALTER TABLE "field_purchase"
  ADD CONSTRAINT "field_purchase_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "field_purchase_supplier_id_idx" ON "field_purchase" ("supplier_id");
