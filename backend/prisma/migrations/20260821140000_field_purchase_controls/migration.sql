-- Stage E: the controls that make a reimbursement model defensible.
--
-- Four things land here, all additive:
--
--  1. A second sign-off STATUS rather than a flag. `approved` stays unreachable
--     until the second signer acts, and the stock effect waits with it - an
--     approval that already moved stock is not really pending anything.
--
--  2. `field_purchase_kind`. A refund is the same shape as the purchase it
--     reverses (same receipt, lines, review, trail), so it is a kind of
--     field_purchase pointing at its parent rather than a second model that
--     would have to be reconciled against the first. Amounts stay positive;
--     the kind is what says which way they point.
--
--  3. The second-sign-off threshold on the ORGANIZATION. Per-grant would put the
--     ceiling on the purchaser's own row, which is the wrong side of a
--     separation-of-duties control. Null disables it.
--
--  4. A (vendor, date) index. The duplicate and velocity checks both sweep one
--     vendor's recent purchases, and without it that is a table scan on every
--     submit.
--
-- No backfill: every existing row is a `purchase` with no parent, which is what
-- the defaults say.

ALTER TYPE "field_purchase_status" ADD VALUE 'pending_second_signoff' BEFORE 'approved';

CREATE TYPE "field_purchase_kind" AS ENUM ('purchase', 'refund');

ALTER TABLE "organization"
    ADD COLUMN "field_purchase_second_signoff_threshold" DECIMAL(10,2);

ALTER TABLE "field_purchase"
    ADD COLUMN "kind"                 "field_purchase_kind" NOT NULL DEFAULT 'purchase',
    ADD COLUMN "parent_purchase_id"   TEXT,
    ADD COLUMN "refund_settled_at"    TIMESTAMP(3),
    ADD COLUMN "second_signoff_at"    TIMESTAMP(3),
    ADD COLUMN "second_signoff_by_id" TEXT,
    ADD COLUMN "second_signoff_note"  TEXT;

ALTER TABLE "field_purchase"
    ADD CONSTRAINT "field_purchase_parent_purchase_id_fkey"
        FOREIGN KEY ("parent_purchase_id") REFERENCES "field_purchase"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "field_purchase_second_signoff_by_id_fkey"
        FOREIGN KEY ("second_signoff_by_id") REFERENCES "dispatcher"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "field_purchase_organization_id_vendor_name_purchased_at_idx"
    ON "field_purchase"("organization_id", "vendor_name", "purchased_at");
CREATE INDEX "field_purchase_parent_purchase_id_idx"
    ON "field_purchase"("parent_purchase_id");
