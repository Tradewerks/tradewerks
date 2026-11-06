-- Platform rules (Phase 2 spec §3.1); rows are synced from code at backend startup.
CREATE TABLE "tax_taxability_rule" (
    "id" TEXT NOT NULL,
    "state_code" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "citation" TEXT NOT NULL,
    "citation_url" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "pack" TEXT NOT NULL,
    "pack_version" INTEGER NOT NULL,
    CONSTRAINT "tax_taxability_rule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tax_taxability_rule_outcome_chk" CHECK ("outcome" IN ('taxable', 'exempt', 'follows_job'))
);
CREATE UNIQUE INDEX "tax_taxability_rule_state_code_category_effective_from_key"
    ON "tax_taxability_rule"("state_code", "category", "effective_from");
CREATE INDEX "tax_taxability_rule_state_code_idx" ON "tax_taxability_rule"("state_code");

-- Org overrides (§3.2)
CREATE TABLE "org_taxability_override" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "state_code" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "taxable" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "org_taxability_override_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "org_taxability_override_organization_id_state_code_category_key"
    ON "org_taxability_override"("organization_id", "state_code", "category");
ALTER TABLE "org_taxability_override" ADD CONSTRAINT "org_taxability_override_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Org primary pack; documents' work class; inventory default category (§3.2, §3.3)
ALTER TABLE "organization" ADD COLUMN "tax_primary_pack" TEXT;
ALTER TABLE "quote" ADD COLUMN "work_class" TEXT;
ALTER TABLE "job" ADD COLUMN "work_class" TEXT;
ALTER TABLE "invoice" ADD COLUMN "work_class" TEXT;
ALTER TABLE "recurring_plan" ADD COLUMN "work_class" TEXT;
ALTER TABLE "inventory_item" ADD COLUMN "tax_category" TEXT;

-- Line taxability provenance (§3.3). The source CHECK backs the closed Zod set.
ALTER TABLE "quote_line_item" ADD COLUMN "tax_category" TEXT,
    ADD COLUMN "taxability_source" TEXT,
    ADD COLUMN "taxability_rule_id" TEXT,
    ADD CONSTRAINT "quote_line_item_taxability_source_chk"
        CHECK ("taxability_source" IN ('rule', 'org_override', 'manual', 'default'));
ALTER TABLE "job_line_item" ADD COLUMN "tax_category" TEXT,
    ADD COLUMN "taxability_source" TEXT,
    ADD COLUMN "taxability_rule_id" TEXT,
    ADD CONSTRAINT "job_line_item_taxability_source_chk"
        CHECK ("taxability_source" IN ('rule', 'org_override', 'manual', 'default'));
ALTER TABLE "job_visit_line_item" ADD COLUMN "tax_category" TEXT,
    ADD COLUMN "taxability_source" TEXT,
    ADD COLUMN "taxability_rule_id" TEXT,
    ADD CONSTRAINT "job_visit_line_item_taxability_source_chk"
        CHECK ("taxability_source" IN ('rule', 'org_override', 'manual', 'default'));
ALTER TABLE "invoice_line_item" ADD COLUMN "tax_category" TEXT,
    ADD COLUMN "taxability_source" TEXT,
    ADD COLUMN "taxability_rule_id" TEXT,
    ADD CONSTRAINT "invoice_line_item_taxability_source_chk"
        CHECK ("taxability_source" IN ('rule', 'org_override', 'manual', 'default'));
ALTER TABLE "recurring_plan_line_item" ADD COLUMN "tax_category" TEXT,
    ADD COLUMN "taxability_source" TEXT,
    ADD COLUMN "taxability_rule_id" TEXT,
    ADD CONSTRAINT "recurring_plan_line_item_taxability_source_chk"
        CHECK ("taxability_source" IN ('rule', 'org_override', 'manual', 'default'));

-- Tiers that include tax_auto include both packs (Legacy included).
UPDATE "plan_version"
SET "modules" = "modules" || ARRAY['tax_pack_hvac', 'tax_pack_cleaning']
WHERE 'tax_auto' = ANY("modules") AND NOT ('tax_pack_hvac' = ANY("modules"));
