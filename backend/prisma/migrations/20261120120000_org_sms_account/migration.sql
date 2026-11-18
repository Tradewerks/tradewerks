-- CreateTable
CREATE TABLE "org_sms_account" (
    "organization_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'twilio',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "failure_reason" TEXT,
    "failed_step" TEXT,
    "registration" JSONB NOT NULL DEFAULT '{}',
    "subaccount_sid" TEXT,
    "auth_token_enc" TEXT,
    "profile_sid" TEXT,
    "brand_sid" TEXT,
    "messaging_service_sid" TEXT,
    "campaign_sid" TEXT,
    "phone_number" TEXT,
    "phone_number_sid" TEXT,
    "submitted_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "last_polled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_sms_account_pkey" PRIMARY KEY ("organization_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_sms_account_subaccount_sid_key" ON "org_sms_account"("subaccount_sid");

-- CreateIndex
CREATE UNIQUE INDEX "org_sms_account_messaging_service_sid_key" ON "org_sms_account"("messaging_service_sid");

-- AddForeignKey
ALTER TABLE "org_sms_account" ADD CONSTRAINT "org_sms_account_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CHECK constraint: Prisma can't express it, so it lives only here.
ALTER TABLE "org_sms_account" ADD CONSTRAINT "org_sms_account_status_chk" CHECK ("status" IN ('draft', 'submitted', 'brand_pending', 'campaign_pending', 'active', 'failed', 'suspended'));
ALTER TABLE "org_sms_account" ADD CONSTRAINT "org_sms_account_failed_step_chk" CHECK ("failed_step" IN ('brand', 'campaign', 'number'));

-- Every tier gets an explicit text-message cap: a missing key reads as
-- unlimited, which must never happen for a per-segment cost. Unlike the other
-- meters, Legacy gets 0 too. The sms module itself is added to no plan; staff
-- grant it per org.
UPDATE "plan_version"
SET "limits" = "limits" || jsonb_build_object(
    'sms_segments_month',
    CASE "plan_key"
        WHEN 'pro' THEN 500
        WHEN 'enterprise' THEN 5000
        ELSE 0
    END
)
WHERE NOT ("limits" ? 'sms_segments_month');
