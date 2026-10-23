-- Records which QuickBooks company the stored tax codes came from (cleared on a company change).
ALTER TABLE "organization" ADD COLUMN "qb_tax_codes_realm_id" TEXT;

-- Connected orgs: the codes on file were chosen against the current company.
UPDATE "organization" SET "qb_tax_codes_realm_id" = "qb_realm_id" WHERE "qb_realm_id" IS NOT NULL;

-- Disconnected orgs that still hold codes: the company they came from is unknown, so the next
-- connect (to any company) must count as a change and clear them.
UPDATE "organization" o SET "qb_tax_codes_realm_id" = 'unknown'
WHERE o."qb_realm_id" IS NULL AND (o."qb_passthrough_tax_code_id" IS NOT NULL
  OR EXISTS (SELECT 1 FROM "tax_group" g WHERE g."organization_id" = o."id" AND g."qb_tax_code_id" IS NOT NULL));
