-- CreateTable
CREATE TABLE "visit_tech_drive" (
    "id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "tech_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "visit_tech_drive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "visit_tech_drive_visit_id_idx" ON "visit_tech_drive"("visit_id");

-- CreateIndex
CREATE INDEX "visit_tech_drive_tech_id_started_at_idx" ON "visit_tech_drive"("tech_id", "started_at");

-- AddForeignKey
ALTER TABLE "visit_tech_drive" ADD CONSTRAINT "visit_tech_drive_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "job_visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_tech_drive" ADD CONSTRAINT "visit_tech_drive_tech_id_fkey" FOREIGN KEY ("tech_id") REFERENCES "technician"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
