-- CreateTable
CREATE TABLE "timesheet_week" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "technician_id" TEXT NOT NULL,
    "week_start" DATE NOT NULL,
    "approved_at" TIMESTAMP(3),
    "approved_by_dispatcher_id" TEXT,
    "qb_sync_status" "qb_sync_status" NOT NULL DEFAULT 'not_synced',
    "qb_synced_at" TIMESTAMP(3),
    "qb_error" TEXT,

    CONSTRAINT "timesheet_week_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "timesheet_week_organization_id_week_start_idx" ON "timesheet_week"("organization_id", "week_start");

-- CreateIndex
CREATE UNIQUE INDEX "timesheet_week_technician_id_week_start_key" ON "timesheet_week"("technician_id", "week_start");

-- AddForeignKey
ALTER TABLE "timesheet_week" ADD CONSTRAINT "timesheet_week_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_week" ADD CONSTRAINT "timesheet_week_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "technician"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_week" ADD CONSTRAINT "timesheet_week_approved_by_dispatcher_id_fkey" FOREIGN KEY ("approved_by_dispatcher_id") REFERENCES "dispatcher"("id") ON DELETE SET NULL ON UPDATE CASCADE;
