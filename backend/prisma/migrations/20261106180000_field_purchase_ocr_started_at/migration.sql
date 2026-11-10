-- AlterTable
ALTER TABLE "field_purchase" ADD COLUMN     "ocr_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ocr_started_at" TIMESTAMP(3);

-- Reads in flight when this lands get a start time, so the sweeper can see them.
UPDATE "field_purchase" SET "ocr_started_at" = "updated_at", "ocr_attempts" = 1
WHERE "ocr_status" = 'pending';

-- The sweeper's scan. Partial: Prisma's DSL can't express it, so it lives only here.
CREATE INDEX "field_purchase_ocr_pending_started_idx" ON "field_purchase"("ocr_started_at")
  WHERE "ocr_status" = 'pending';
