-- Vendor origin for purchased stock.
--
-- Before this, the only supplier anywhere in the schema was stock_batch.supplier:
-- free text, written solely when a NEW lot was created, so it existed only for
-- batch-tracked items. A plain receive recorded no origin at all.
--
-- This promotes that free text to a real entity and hangs it off the ledger, so
-- a receipt can name who billed it regardless of whether the item is tracked.

-- 1. The entity ------------------------------------------------------------
CREATE TABLE "supplier" (
    "id"              TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "name_key"        TEXT NOT NULL,
    "account_number"  TEXT,
    "contact_name"    TEXT,
    "phone"           TEXT,
    "email"           TEXT,
    "notes"           TEXT,
    "is_active"       BOOLEAN NOT NULL DEFAULT true,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "supplier_organization_id_name_key_key"
    ON "supplier"("organization_id", "name_key");
CREATE INDEX "supplier_organization_id_is_active_idx"
    ON "supplier"("organization_id", "is_active");

ALTER TABLE "supplier" ADD CONSTRAINT "supplier_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. The foreign keys ------------------------------------------------------
ALTER TABLE "stock_movement" ADD COLUMN "supplier_id" TEXT;
ALTER TABLE "stock_batch"    ADD COLUMN "supplier_id" TEXT;

CREATE INDEX "stock_movement_supplier_id_created_at_idx"
    ON "stock_movement"("supplier_id", "created_at");
CREATE INDEX "stock_batch_supplier_id_idx"
    ON "stock_batch"("supplier_id");

ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_supplier_id_fkey"
    FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_batch" ADD CONSTRAINT "stock_batch_supplier_id_fkey"
    FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Seed suppliers from the existing free text ----------------------------
-- Normalization is case + whitespace ONLY. Deliberately not fuzzy: "Ferguson"
-- and "Ferguson Plumbing" are different companies billing different prices, and
-- silently merging them would corrupt every per-supplier figure downstream.
-- DISTINCT ON picks one display spelling per (org, name_key); the rest collapse
-- into it, which is exactly the dedupe intent.
INSERT INTO "supplier" ("id", "organization_id", "name", "name_key", "created_at", "updated_at")
SELECT DISTINCT ON (b."organization_id", lower(regexp_replace(btrim(b."supplier"), '\s+', ' ', 'g')))
    gen_random_uuid()::text,
    b."organization_id",
    btrim(b."supplier"),
    lower(regexp_replace(btrim(b."supplier"), '\s+', ' ', 'g')),
    now(),
    now()
FROM "stock_batch" b
WHERE b."supplier" IS NOT NULL
  AND btrim(b."supplier") <> ''
ORDER BY
    b."organization_id",
    lower(regexp_replace(btrim(b."supplier"), '\s+', ' ', 'g')),
    -- Oldest spelling wins: it's the one the org has been reading the longest.
    b."created_at" ASC;

-- 4. Point the lots at their new entity ------------------------------------
UPDATE "stock_batch" b
SET "supplier_id" = s."id"
FROM "supplier" s
WHERE s."organization_id" = b."organization_id"
  AND s."name_key" = lower(regexp_replace(btrim(b."supplier"), '\s+', ' ', 'g'))
  AND b."supplier" IS NOT NULL
  AND btrim(b."supplier") <> '';

-- 5. Propagate to the intake movements that allocated against those lots ----
-- Only intake reasons: a `restock` or `parts_used` movement touching a lot is
-- internal handling of stock already bought, not a purchase from a vendor.
UPDATE "stock_movement" m
SET "supplier_id" = b."supplier_id"
FROM "stock_movement_batch" mb
JOIN "stock_batch" b ON b."id" = mb."batch_id"
WHERE mb."movement_id" = m."id"
  AND b."supplier_id" IS NOT NULL
  AND m."reason" IN ('receive', 'supplier_purchase');

-- 6. Everything else stays NULL --------------------------------------------
-- No statement here, on purpose. Movements with no lot never had an origin
-- recorded, and inventing one (from the item's most common vendor, say) would
-- fabricate exactly the per-supplier costs this feature exists to report
-- truthfully. The UI labels these "Unrecorded" and shows the coverage ratio.
