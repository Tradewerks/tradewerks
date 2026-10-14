-- Vendor ↔ QuickBooks link, and the vendor price list.
--
-- Follows 20260813120000_supplier_origin, which made suppliers real entities and
-- attributed every receipt to one. Two things that work only once that exists:
--
--   1. supplier_external_mapping — the same provider/account/external triple
--      client_external_mapping and item_external_mapping already use, so vendor
--      identity has ONE home across our DB and the connected accounting file.
--   2. supplier_item — what a vendor charges for an item, so the reorder
--      forecast can name who to buy from instead of dead-ending at a quantity.

-- 1. Vendor identity across systems ---------------------------------------
CREATE TABLE "supplier_external_mapping" (
    "id"          TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "provider"    TEXT NOT NULL,
    "account_id"  TEXT NOT NULL DEFAULT '',
    "external_id" TEXT NOT NULL,

    CONSTRAINT "supplier_external_mapping_pkey" PRIMARY KEY ("id")
);

-- Neither side can be double-linked: one QBO vendor to one supplier, and one
-- supplier to one QBO vendor, per connected company file.
CREATE UNIQUE INDEX "supplier_external_mapping_provider_account_id_external_id_key"
    ON "supplier_external_mapping"("provider", "account_id", "external_id");
CREATE UNIQUE INDEX "supplier_external_mapping_provider_supplier_id_account_id_key"
    ON "supplier_external_mapping"("provider", "supplier_id", "account_id");
CREATE INDEX "supplier_external_mapping_supplier_id_idx"
    ON "supplier_external_mapping"("supplier_id");

ALTER TABLE "supplier_external_mapping"
    ADD CONSTRAINT "supplier_external_mapping_supplier_id_fkey"
    FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. The vendor price list -------------------------------------------------
CREATE TABLE "supplier_item" (
    "id"                TEXT NOT NULL,
    "organization_id"   TEXT NOT NULL,
    "supplier_id"       TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    -- The vendor's own part number — what you order by, rarely our SKU.
    "vendor_sku"        TEXT,
    -- Negotiated (manual) vs observed (written by recordMovements on intake).
    -- Kept apart because one is what you WILL pay and the other is what you
    -- happened to pay; the forecast prefers the contract and says which it used.
    "contract_price"    DECIMAL(10,2),
    "last_price"        DECIMAL(10,2),
    "last_purchased_at" TIMESTAMP(3),
    "is_preferred"      BOOLEAN NOT NULL DEFAULT false,
    "lead_time_days"    INTEGER,
    "min_order_qty"     DECIMAL(10,2),
    "notes"             TEXT,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_item_pkey" PRIMARY KEY ("id")
);

-- One row per vendor per item: the upsert on intake depends on this.
CREATE UNIQUE INDEX "supplier_item_supplier_id_inventory_item_id_key"
    ON "supplier_item"("supplier_id", "inventory_item_id");
CREATE INDEX "supplier_item_organization_id_inventory_item_id_idx"
    ON "supplier_item"("organization_id", "inventory_item_id");
-- Serves the forecast join, which reads one preferred row per item.
CREATE INDEX "supplier_item_inventory_item_id_is_preferred_idx"
    ON "supplier_item"("inventory_item_id", "is_preferred");
-- "Exactly one preferred vendor per item" is a comment in clearOtherPreferred,
-- not a fact enforced there: clear-then-set runs across two statements in one
-- transaction, so two concurrent requests preferring different vendors for the
-- same item under READ COMMITTED can both commit, leaving two preferred rows
-- the forecast then picks between arbitrarily. This partial unique index makes
-- the second commit fail loudly instead. (Not expressible in schema.prisma —
-- Prisma's DSL has no partial-index syntax — so this is intentional drift the
-- schema comment on supplier_item.is_preferred calls out.)
CREATE UNIQUE INDEX "supplier_item_one_preferred_per_item"
    ON "supplier_item"("inventory_item_id")
    WHERE "is_preferred" = true;

ALTER TABLE "supplier_item"
    ADD CONSTRAINT "supplier_item_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_item"
    ADD CONSTRAINT "supplier_item_supplier_id_fkey"
    FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Cascade from the item too: a price-list entry for a deleted item is noise,
-- and no history is lost — the ledger keeps the purchases themselves.
ALTER TABLE "supplier_item"
    ADD CONSTRAINT "supplier_item_inventory_item_id_fkey"
    FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_item"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
