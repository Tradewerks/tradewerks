-- AlterTable
ALTER TABLE "vehicle_maintenance_reminder" ADD COLUMN     "baseline_at" TIMESTAMP(3),
ADD COLUMN     "baseline_odometer_mi" INTEGER;
