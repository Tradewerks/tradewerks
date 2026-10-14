/*
  Warnings:

  - You are about to drop the column `interval_months` on the `vehicle_maintenance_reminder` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "interval_unit" AS ENUM ('days', 'weeks', 'months', 'years');

-- AlterTable
ALTER TABLE "vehicle_maintenance_reminder" DROP COLUMN "interval_months",
ADD COLUMN     "interval_count" INTEGER,
ADD COLUMN     "interval_unit" "interval_unit";
