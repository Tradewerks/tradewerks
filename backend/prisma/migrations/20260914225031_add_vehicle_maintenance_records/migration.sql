-- CreateEnum
CREATE TYPE "vehicle_maintenance_category" AS ENUM ('oil_change', 'tire', 'brake', 'inspection', 'registration', 'repair', 'other');

-- AlterTable
ALTER TABLE "vehicle" ADD COLUMN     "current_odometer_mi" INTEGER,
ADD COLUMN     "odometer_updated_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "vehicle_maintenance_record" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "category" "vehicle_maintenance_category" NOT NULL,
    "performed_at" TIMESTAMP(3) NOT NULL,
    "odometer_mi" INTEGER,
    "interval_miles" INTEGER,
    "interval_months" INTEGER,
    "cost" DECIMAL(10,2),
    "vendor_name" TEXT,
    "notes" TEXT,
    "performed_by_id" TEXT,
    "performed_by_tech_id" TEXT,
    "source_purchase_line_id" TEXT,
    "source_field_purchase_line_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_maintenance_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_maintenance_record_vehicle_id_idx" ON "vehicle_maintenance_record"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_maintenance_record_organization_id_idx" ON "vehicle_maintenance_record"("organization_id");

-- CreateIndex
CREATE INDEX "vehicle_maintenance_record_category_idx" ON "vehicle_maintenance_record"("category");

-- CreateIndex
CREATE INDEX "vehicle_maintenance_record_performed_at_idx" ON "vehicle_maintenance_record"("performed_at");

-- AddForeignKey
ALTER TABLE "vehicle_maintenance_record" ADD CONSTRAINT "vehicle_maintenance_record_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_maintenance_record" ADD CONSTRAINT "vehicle_maintenance_record_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_maintenance_record" ADD CONSTRAINT "vehicle_maintenance_record_performed_by_id_fkey" FOREIGN KEY ("performed_by_id") REFERENCES "dispatcher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_maintenance_record" ADD CONSTRAINT "vehicle_maintenance_record_performed_by_tech_id_fkey" FOREIGN KEY ("performed_by_tech_id") REFERENCES "technician"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_maintenance_record" ADD CONSTRAINT "vehicle_maintenance_record_source_purchase_line_id_fkey" FOREIGN KEY ("source_purchase_line_id") REFERENCES "purchase_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_maintenance_record" ADD CONSTRAINT "vehicle_maintenance_record_source_field_purchase_line_id_fkey" FOREIGN KEY ("source_field_purchase_line_id") REFERENCES "field_purchase_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;
