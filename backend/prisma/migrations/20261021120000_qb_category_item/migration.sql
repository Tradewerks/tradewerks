-- Per-realm QuickBooks Service item per tax category, for invoice lines with no mapped inventory item.
CREATE TABLE "qb_category_item" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "qb_category_item_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "qb_category_item_organization_id_account_id_category_key"
    ON "qb_category_item"("organization_id", "account_id", "category");
ALTER TABLE "qb_category_item" ADD CONSTRAINT "qb_category_item_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
