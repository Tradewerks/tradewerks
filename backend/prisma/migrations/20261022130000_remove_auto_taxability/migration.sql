-- Remove automatic line taxability (spec 2026-10-21-remove-auto-taxability-design.md §5).
-- inventory_item.taxable and the QB stand-in columns already exist (20261022120000).

DROP TABLE "tax_taxability_rule";
DROP TABLE "org_taxability_override";
DROP TABLE "org_taxability_confirmation";
DROP TABLE "qb_category_item";
DROP TABLE "tax_monitor_state";

ALTER TABLE "organization" DROP COLUMN "tax_primary_pack";
ALTER TABLE "quote" DROP COLUMN "work_class";
ALTER TABLE "job" DROP COLUMN "work_class";
ALTER TABLE "invoice" DROP COLUMN "work_class";
ALTER TABLE "recurring_plan" DROP COLUMN "work_class";
ALTER TABLE "inventory_item" DROP COLUMN "tax_category";

ALTER TABLE "quote_line_item" DROP CONSTRAINT IF EXISTS "quote_line_item_taxability_source_chk",
    DROP COLUMN "tax_category", DROP COLUMN "taxability_source", DROP COLUMN "taxability_rule_id";
ALTER TABLE "job_line_item" DROP CONSTRAINT IF EXISTS "job_line_item_taxability_source_chk",
    DROP COLUMN "tax_category", DROP COLUMN "taxability_source", DROP COLUMN "taxability_rule_id";
ALTER TABLE "job_visit_line_item" DROP CONSTRAINT IF EXISTS "job_visit_line_item_taxability_source_chk",
    DROP COLUMN "tax_category", DROP COLUMN "taxability_source", DROP COLUMN "taxability_rule_id";
ALTER TABLE "invoice_line_item" DROP CONSTRAINT IF EXISTS "invoice_line_item_taxability_source_chk",
    DROP COLUMN "tax_category", DROP COLUMN "taxability_source", DROP COLUMN "taxability_rule_id";
ALTER TABLE "recurring_plan_line_item" DROP CONSTRAINT IF EXISTS "recurring_plan_line_item_taxability_source_chk",
    DROP COLUMN "tax_category", DROP COLUMN "taxability_source", DROP COLUMN "taxability_rule_id";

UPDATE "plan_version"
SET "modules" = array_remove(array_remove("modules", 'tax_pack_hvac'), 'tax_pack_cleaning')
WHERE "modules" && ARRAY['tax_pack_hvac', 'tax_pack_cleaning'];

UPDATE "org_entitlement"
SET "module_grants" = "module_grants" - 'tax_pack_hvac' - 'tax_pack_cleaning',
    "module_choices" = "module_choices" - 'tax_pack_hvac' - 'tax_pack_cleaning';

UPDATE "organization_role"
SET "permissions" = array_remove("permissions", 'confirm_taxability')
WHERE "permissions" @> ARRAY['confirm_taxability'];

DELETE FROM "dispatcher_notification"
WHERE "type" IN ('taxability_review_requested', 'taxability_rule_expiring');
