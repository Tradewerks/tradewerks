/*
  Warnings:

  - A unique constraint covering the columns `[organization_id,name,created_by_id]` on the table `saved_report` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "saved_report_organization_id_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "saved_report_organization_id_name_created_by_id_key" ON "saved_report"("organization_id", "name", "created_by_id");
