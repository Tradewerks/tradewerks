CREATE TABLE "plan" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "assignable" BOOLEAN NOT NULL DEFAULT true,
    "is_signup_default" BOOLEAN NOT NULL DEFAULT false,
    "is_trial_default" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    CONSTRAINT "plan_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "plan_version" (
    "id" TEXT NOT NULL,
    "plan_key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "modules" TEXT[],
    "limits" JSONB NOT NULL DEFAULT '{}',
    "note" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "plan_version_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "plan_version_plan_key_version_key" ON "plan_version"("plan_key", "version");
ALTER TABLE "plan_version" ADD CONSTRAINT "plan_version_plan_key_fkey"
    FOREIGN KEY ("plan_key") REFERENCES "plan"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "org_entitlement" (
    "organization_id" TEXT NOT NULL,
    "plan_version_id" TEXT NOT NULL,
    "plan_source" TEXT NOT NULL,
    "template_key" TEXT NOT NULL DEFAULT 'general',
    "trial_plan_version_id" TEXT,
    "trial_ends_at" TIMESTAMP(3),
    "trial_warned_3d_at" TIMESTAMP(3),
    "trial_warned_end_at" TIMESTAMP(3),
    "module_choices" JSONB NOT NULL DEFAULT '{}',
    "module_grants" JSONB NOT NULL DEFAULT '{}',
    "limit_overrides" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "org_entitlement_pkey" PRIMARY KEY ("organization_id")
);
ALTER TABLE "org_entitlement" ADD CONSTRAINT "org_entitlement_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "org_entitlement" ADD CONSTRAINT "org_entitlement_plan_version_id_fkey"
    FOREIGN KEY ("plan_version_id") REFERENCES "plan_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "org_entitlement" ADD CONSTRAINT "org_entitlement_trial_plan_version_id_fkey"
    FOREIGN KEY ("trial_plan_version_id") REFERENCES "plan_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only the Legacy tier ships to production. Other tiers are undecided and exist
-- solely as dev fixtures created by prisma/seed.ts.
INSERT INTO "plan" ("key", "label", "assignable", "is_signup_default", "is_trial_default") VALUES
    ('legacy', 'Legacy', false, false, false);

INSERT INTO "plan_version" ("id", "plan_key", "version", "modules", "limits", "note") VALUES
    ('pv_legacy_1', 'legacy', 1,
     ARRAY['quotes','recurring_plans','projects','inventory','fleet','vehicle_stock','purchasing','field_purchases','followups','disputes','advanced_reporting','quickbooks','tax_auto','ai_assistant','security_plus'],
     '{"dispatchers":null,"technicians":null,"tax_lookups_month":null,"ai_calls_month":null}', 'seed');

-- Existing orgs: everything they have today, with Followups copying its current switch.
INSERT INTO "org_entitlement" ("organization_id", "plan_version_id", "plan_source", "template_key", "module_choices", "updated_at")
SELECT o."id", 'pv_legacy_1', 'migration', 'hvac',
       jsonb_build_object(
           'quotes', true, 'recurring_plans', true, 'projects', true, 'inventory', true,
           'fleet', true, 'vehicle_stock', true, 'purchasing', true, 'field_purchases', true,
           'disputes', true, 'followups', o."followups_enabled"
       ),
       CURRENT_TIMESTAMP
FROM "organization" o;
