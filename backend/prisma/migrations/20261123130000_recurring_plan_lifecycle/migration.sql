-- Recurring plan lifecycle: Expired status, default technician, expiry/top-up bookkeeping,
-- invoice schedule failure tracking.

-- AlterEnum (new value is not referenced elsewhere in this migration)
ALTER TYPE "recurring_plan_status" ADD VALUE 'Expired';

-- AlterTable
ALTER TABLE "recurring_plan" ADD COLUMN "default_technician_id" TEXT,
ADD COLUMN "expiry_notified_at" TIMESTAMP(3),
ADD COLUMN "last_topped_up_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "invoice_schedule" ADD COLUMN "last_failure_at" TIMESTAMP(3),
ADD COLUMN "last_failure_message" TEXT;

-- CreateIndex
CREATE INDEX "recurring_plan_status_ends_at_idx" ON "recurring_plan"("status", "ends_at");

-- CreateIndex
CREATE INDEX "recurring_plan_default_technician_id_idx" ON "recurring_plan"("default_technician_id");

-- AddForeignKey
ALTER TABLE "recurring_plan" ADD CONSTRAINT "recurring_plan_default_technician_id_fkey" FOREIGN KEY ("default_technician_id") REFERENCES "technician"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Plans follow their organization's timezone; realign any that drifted.
UPDATE "recurring_plan" p
SET "timezone" = o."timezone"
FROM "organization" o
WHERE p."organization_id" = o."id"
  AND p."timezone" <> o."timezone";
