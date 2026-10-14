-- CreateTable
CREATE TABLE "vehicle_maintenance_reminder" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "category" "vehicle_maintenance_category" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "interval_miles" INTEGER,
    "interval_months" INTEGER,
    "repeats" BOOLEAN NOT NULL DEFAULT true,
    "due_at" TIMESTAMP(3),
    "due_odometer_mi" INTEGER,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_maintenance_reminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_maintenance_reminder_vehicle_id_idx" ON "vehicle_maintenance_reminder"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_maintenance_reminder_organization_id_idx" ON "vehicle_maintenance_reminder"("organization_id");

-- CreateIndex
CREATE INDEX "vehicle_maintenance_reminder_category_idx" ON "vehicle_maintenance_reminder"("category");

-- AddForeignKey
ALTER TABLE "vehicle_maintenance_reminder" ADD CONSTRAINT "vehicle_maintenance_reminder_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_maintenance_reminder" ADD CONSTRAINT "vehicle_maintenance_reminder_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
