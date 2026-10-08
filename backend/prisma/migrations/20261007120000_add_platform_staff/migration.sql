CREATE TABLE "platform_staff" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password" TEXT,
    "status" TEXT NOT NULL DEFAULT 'invited',
    "invite_token_hash" TEXT,
    "invite_expires_at" TIMESTAMP(3),
    "invited_by_id" TEXT,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "disabled_at" TIMESTAMP(3),
    "last_login" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_staff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_staff_email_key" ON "platform_staff"("email");
CREATE UNIQUE INDEX "platform_staff_invite_token_hash_key" ON "platform_staff"("invite_token_hash");

-- Exactly one signup default and one trial default (spec §9.2). Not in schema.prisma.
CREATE UNIQUE INDEX "plan_one_signup_default" ON "plan"("is_signup_default") WHERE "is_signup_default" = true;
CREATE UNIQUE INDEX "plan_one_trial_default" ON "plan"("is_trial_default") WHERE "is_trial_default" = true;
