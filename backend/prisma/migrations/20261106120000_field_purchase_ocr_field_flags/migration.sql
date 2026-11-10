-- AlterTable
ALTER TABLE "field_purchase" ADD COLUMN "ocr_field_flags" JSONB;
ALTER TABLE "field_purchase" ADD COLUMN "ocr_field_review" JSONB NOT NULL DEFAULT '{}';
