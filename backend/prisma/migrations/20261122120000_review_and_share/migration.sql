-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "review_url" TEXT;

-- AlterTable
ALTER TABLE "job_note_photo" ADD COLUMN     "share_with_customer" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "technician" ADD COLUMN     "photo_url" TEXT;
