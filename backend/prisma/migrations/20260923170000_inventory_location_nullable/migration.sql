-- AlterTable
ALTER TABLE "inventory_item" ALTER COLUMN "location" DROP NOT NULL;

-- Collapse the empty strings three creation paths have been writing to satisfy
-- the old NOT NULL constraint (field purchase unknown-part, dispatch quick-add
-- unknown-part, QuickBooks import). Without this the codebase carries two
-- representations of "no location" forever and every read site handles both.
UPDATE "inventory_item" SET "location" = NULL WHERE btrim("location") = '';
