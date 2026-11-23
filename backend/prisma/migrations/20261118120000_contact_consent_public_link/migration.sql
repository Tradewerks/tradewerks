-- AlterTable
ALTER TABLE "client_contact" ADD COLUMN     "notify_visits" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "contact_consent" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_detail" TEXT,
    "changed_by_dispatcher_id" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_link" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "first_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contact_consent_organization_id_idx" ON "contact_consent"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_consent_contact_id_channel_key" ON "contact_consent"("contact_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "public_link_token_hash_key" ON "public_link"("token_hash");

-- CreateIndex
CREATE INDEX "public_link_organization_id_purpose_entity_id_idx" ON "public_link"("organization_id", "purpose", "entity_id");

-- AddForeignKey
ALTER TABLE "contact_consent" ADD CONSTRAINT "contact_consent_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_consent" ADD CONSTRAINT "contact_consent_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_link" ADD CONSTRAINT "public_link_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CHECK constraints: Prisma can't express them, so they live only here.
ALTER TABLE "contact_consent" ADD CONSTRAINT "contact_consent_channel_chk" CHECK ("channel" IN ('email', 'sms'));
ALTER TABLE "contact_consent" ADD CONSTRAINT "contact_consent_status_chk" CHECK ("status" IN ('subscribed', 'unsubscribed'));
ALTER TABLE "contact_consent" ADD CONSTRAINT "contact_consent_source_chk" CHECK ("source" IN ('dispatcher', 'unsubscribe_link', 'sms_keyword', 'bounce', 'spam_complaint', 'provider'));
ALTER TABLE "public_link" ADD CONSTRAINT "public_link_purpose_chk" CHECK ("purpose" IN ('unsubscribe', 'quote', 'invoice', 'visit'));
