-- AlterEnum
ALTER TYPE "email_template_category" ADD VALUE 'visit_confirmed';
ALTER TYPE "email_template_category" ADD VALUE 'visit_reminder';
ALTER TYPE "email_template_category" ADD VALUE 'visit_rescheduled';
ALTER TYPE "email_template_category" ADD VALUE 'visit_cancelled';
ALTER TYPE "email_template_category" ADD VALUE 'tech_on_the_way';
ALTER TYPE "email_template_category" ADD VALUE 'tech_running_late';
ALTER TYPE "email_template_category" ADD VALUE 'visit_completed';
ALTER TYPE "email_template_category" ADD VALUE 'review_request';

-- AlterTable
ALTER TABLE "email_template" ADD COLUMN     "sms_body" TEXT;

-- CreateTable
CREATE TABLE "customer_message" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'out',
    "event" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "client_id" TEXT,
    "contact_id" TEXT,
    "recipient" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "skip_reason" TEXT,
    "send_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "send_started_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "provider_message_id" TEXT,
    "subject" TEXT,
    "body" TEXT,
    "segments" INTEGER,
    "error" TEXT,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "opened_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_notification_setting" (
    "organization_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "email_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sms_enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "customer_notification_setting_pkey" PRIMARY KEY ("organization_id","event")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_message_provider_message_id_key" ON "customer_message"("provider_message_id");

-- CreateIndex
CREATE INDEX "customer_message_status_send_after_idx" ON "customer_message"("status", "send_after");

-- CreateIndex
CREATE INDEX "customer_message_organization_id_entity_type_entity_id_idx" ON "customer_message"("organization_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "customer_message_organization_id_client_id_created_at_idx" ON "customer_message"("organization_id", "client_id", "created_at");

-- CreateIndex
CREATE INDEX "customer_message_organization_id_channel_recipient_idx" ON "customer_message"("organization_id", "channel", "recipient");

-- CreateIndex
CREATE UNIQUE INDEX "customer_message_organization_id_dedupe_key_channel_recipie_key" ON "customer_message"("organization_id", "dedupe_key", "channel", "recipient");

-- AddForeignKey
ALTER TABLE "customer_message" ADD CONSTRAINT "customer_message_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_notification_setting" ADD CONSTRAINT "customer_notification_setting_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CHECK constraints: Prisma can't express them, so they live only here.
ALTER TABLE "customer_message" ADD CONSTRAINT "customer_message_direction_chk" CHECK ("direction" IN ('out', 'in'));
ALTER TABLE "customer_message" ADD CONSTRAINT "customer_message_channel_chk" CHECK ("channel" IN ('email', 'sms'));
ALTER TABLE "customer_message" ADD CONSTRAINT "customer_message_status_chk" CHECK ("status" IN ('queued', 'sending', 'sent', 'delivered', 'failed', 'skipped', 'unknown'));

-- Every plan that can have Followups can have Customer messages. Orgs start with
-- the module off (no module choice) and every event off (no setting rows).
UPDATE "plan_version"
SET "modules" = array_append("modules", 'customer_comms')
WHERE 'followups' = ANY("modules") AND NOT ('customer_comms' = ANY("modules"));

-- Data migration: roles that can see or manage Followups get the same access to
-- Customer messages. Idempotent. Permissions are baked into the JWT at login, so
-- users pick these up on their next sign-in or token refresh.
UPDATE "organization_role"
SET "permissions" = array_append("permissions", 'view_customer_comms')
WHERE 'view_followups' = ANY("permissions")
  AND NOT ('view_customer_comms' = ANY("permissions"));

UPDATE "organization_role"
SET "permissions" = array_append("permissions", 'manage_customer_comms')
WHERE 'manage_followups' = ANY("permissions")
  AND NOT ('manage_customer_comms' = ANY("permissions"));
