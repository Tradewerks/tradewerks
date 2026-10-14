/*
  Warnings:

  - A unique constraint covering the columns `[account_id,qb_time_activity_id]` on the table `technician_shift` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[account_id,qb_time_activity_id]` on the table `visit_tech_time_entry` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "technician_shift" ADD COLUMN     "account_id" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "qb_time_activity_id" TEXT;

-- AlterTable
ALTER TABLE "visit_tech_time_entry" ADD COLUMN     "account_id" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "qb_time_activity_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "technician_shift_account_id_qb_time_activity_id_key" ON "technician_shift"("account_id", "qb_time_activity_id");

-- CreateIndex
CREATE UNIQUE INDEX "visit_tech_time_entry_account_id_qb_time_activity_id_key" ON "visit_tech_time_entry"("account_id", "qb_time_activity_id");
