-- The vendor's own ticket number, read off the receipt. Additive and nullable:
-- existing rows have no number and must stay valid.
ALTER TABLE "field_purchase" ADD COLUMN "receipt_number" TEXT;

-- No query uses this today: the duplicate sweep filters on
-- organization_id/kind/status/purchased_at and compares receipt numbers over
-- that candidate set in application code. Kept ahead of a direct lookup by
-- number, which this shape is built for.
CREATE INDEX "field_purchase_organization_id_vendor_name_receipt_number_idx"
  ON "field_purchase" ("organization_id", "vendor_name", "receipt_number");
