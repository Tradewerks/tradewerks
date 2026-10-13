-- CreateEnum
CREATE TYPE "shift_correction_status" AS ENUM ('pending', 'accepted', 'rejected', 'superseded');

-- CreateTable
CREATE TABLE "shift_correction" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "tech_id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "proposed" JSONB NOT NULL,
    "status" "shift_correction_status" NOT NULL DEFAULT 'pending',
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_correction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shift_correction_shift_id_status_idx" ON "shift_correction"("shift_id", "status");

-- CreateIndex
CREATE INDEX "shift_correction_organization_id_status_idx" ON "shift_correction"("organization_id", "status");

-- AddForeignKey
ALTER TABLE "shift_correction" ADD CONSTRAINT "shift_correction_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_correction" ADD CONSTRAINT "shift_correction_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "technician_shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_correction" ADD CONSTRAINT "shift_correction_tech_id_fkey" FOREIGN KEY ("tech_id") REFERENCES "technician"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_correction" ADD CONSTRAINT "shift_correction_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "dispatcher"("id") ON DELETE SET NULL ON UPDATE CASCADE;
