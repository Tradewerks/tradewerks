-- Staff tokens issued before this instant are refused (disable, MFA reset).
ALTER TABLE "platform_staff" ADD COLUMN "sessions_valid_after" TIMESTAMP(3);
