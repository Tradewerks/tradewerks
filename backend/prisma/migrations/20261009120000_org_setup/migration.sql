-- Trials are staff-set per org only (spec D2/D5); nothing reads a trial default.
DROP INDEX IF EXISTS "plan_one_trial_default";
ALTER TABLE "plan" DROP COLUMN "is_trial_default";

ALTER TABLE "dispatcher" ADD COLUMN "invite_token_hash" TEXT;
ALTER TABLE "dispatcher" ADD COLUMN "invite_expires_at" TIMESTAMP(3);
CREATE UNIQUE INDEX "dispatcher_invite_token_hash_key" ON "dispatcher"("invite_token_hash");

ALTER TABLE "org_entitlement" ADD COLUMN "modules_reviewed_at" TIMESTAMP(3);
-- Existing orgs never see the welcome step.
UPDATE "org_entitlement" SET "modules_reviewed_at" = now();
