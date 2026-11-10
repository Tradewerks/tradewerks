ALTER TABLE "platform_staff" ADD COLUMN "enroll_token_hash" TEXT,
ADD COLUMN "enroll_expires_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "platform_staff_enroll_token_hash_key" ON "platform_staff"("enroll_token_hash");
