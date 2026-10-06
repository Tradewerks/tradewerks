-- The Followups switch now lives in org_entitlement.module_choices (copied over by
-- 20261005120000_add_entitlements, which must run first).
ALTER TABLE "organization" DROP COLUMN "followups_enabled";
