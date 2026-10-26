-- Hardened taxability (spec 2026-10-19-hardened-taxability-design.md).

-- Platform rule lifecycle (§4.1). Rows are re-synced from code at startup, so
-- this backfill only has to hold until the first boot; verified rows were
-- checked against their citations on 2026-10-19.
ALTER TABLE "tax_taxability_rule"
    ADD COLUMN "verified_at" DATE,
    ADD COLUMN "review_by" DATE,
    ADD COLUMN "source_url" TEXT,
    ADD COLUMN "source_version" TEXT;

UPDATE "tax_taxability_rule"
SET "verified_at" = DATE '2026-10-19',
    "review_by" = DATE '2027-10-19'
WHERE "verified" = true;

UPDATE "tax_taxability_rule" SET "source_url" = "citation_url", "source_version" = '';

ALTER TABLE "tax_taxability_rule"
    ALTER COLUMN "source_url" SET NOT NULL,
    ALTER COLUMN "source_version" SET NOT NULL,
    DROP COLUMN "verified";

-- Org rule lifecycle (§4.1, §5). Existing overrides were entered in Admin, and
-- their last edit is the closest thing to a confirmation date they have.
ALTER TABLE "org_taxability_override"
    ADD COLUMN "basis" TEXT NOT NULL DEFAULT 'settings',
    ADD COLUMN "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "confirmed_by" TEXT,
    ADD COLUMN "review_by" TIMESTAMP(3),
    ADD COLUMN "source_document_id" TEXT,
    ADD CONSTRAINT "org_taxability_override_basis_chk" CHECK ("basis" IN ('resolution', 'settings'));

UPDATE "org_taxability_override"
SET "confirmed_at" = "updated_at",
    "confirmed_by" = "created_by",
    "review_by" = "updated_at" + INTERVAL '12 months';

ALTER TABLE "org_taxability_override" ALTER COLUMN "review_by" SET NOT NULL;

-- Confirmations of platform rules (§4.1, §4.4).
CREATE TABLE "org_taxability_confirmation" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "state_code" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "pack_version" INTEGER NOT NULL,
    "confirmed_by" TEXT,
    "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "org_taxability_confirmation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "org_taxability_confirmation_organization_id_state_code_category_key"
    ON "org_taxability_confirmation"("organization_id", "state_code", "category");
ALTER TABLE "org_taxability_confirmation" ADD CONSTRAINT "org_taxability_confirmation_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Monitor bookkeeping (§4.5).
CREATE TABLE "tax_monitor_state" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tax_monitor_state_pkey" PRIMARY KEY ("key")
);

-- confirm_taxability re-gates override editing, which lived behind
-- manage_taxes. Same rule as send_document_permissions: it follows the old
-- permission on deploy day so nobody silently loses the ability. Re-runnable;
-- admin-role users bypass the permission array and need no backfill.
UPDATE "organization_role"
SET "permissions" = "permissions" || ARRAY['confirm_taxability']
WHERE "base_tier" = 'dispatcher'
  AND "permissions" && ARRAY['manage_taxes']
  AND NOT ("permissions" @> ARRAY['confirm_taxability']);
