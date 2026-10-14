-- CreateEnum
CREATE TYPE "arrival_status" AS ENUM ('on_time', 'at_risk', 'late', 'arrived', 'unknown');

-- CreateTable
CREATE TABLE "visit_tech_arrival" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "tech_id" TEXT NOT NULL,
    "status" "arrival_status" NOT NULL DEFAULT 'unknown',
    "basis" TEXT NOT NULL,
    "en_route" BOOLEAN NOT NULL DEFAULT false,
    "stop_index" INTEGER NOT NULL DEFAULT 0,
    "due_at" TIMESTAMP(3) NOT NULL,
    "eta_at" TIMESTAMP(3),
    "leave_by_at" TIMESTAMP(3),
    "delay_seconds" INTEGER,
    "drive_seconds" INTEGER,
    "traffic_delay_seconds" INTEGER,
    "distance_meters" INTEGER,
    "arrived_at" TIMESTAMP(3),
    "computed_at" TIMESTAMP(3) NOT NULL,
    "routed_at" TIMESTAMP(3),
    "alerted_late_minutes" INTEGER,
    "alerted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "visit_tech_arrival_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "visit_tech_arrival_organization_id_due_at_idx" ON "visit_tech_arrival"("organization_id", "due_at");

-- CreateIndex
CREATE INDEX "visit_tech_arrival_tech_id_due_at_idx" ON "visit_tech_arrival"("tech_id", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "visit_tech_arrival_visit_id_tech_id_key" ON "visit_tech_arrival"("visit_id", "tech_id");

-- AddForeignKey
ALTER TABLE "visit_tech_arrival" ADD CONSTRAINT "visit_tech_arrival_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_tech_arrival" ADD CONSTRAINT "visit_tech_arrival_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "job_visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_tech_arrival" ADD CONSTRAINT "visit_tech_arrival_tech_id_fkey" FOREIGN KEY ("tech_id") REFERENCES "technician"("id") ON DELETE CASCADE ON UPDATE CASCADE;
