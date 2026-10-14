-- AlterTable
ALTER TABLE "dispatcher" ADD COLUMN "deactivated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "technician" ADD COLUMN "deactivated_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "usage_counter" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "meter" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "warned_at" TIMESTAMP(3),

    CONSTRAINT "usage_counter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usage_counter_organization_id_meter_period_start_key" ON "usage_counter"("organization_id", "meter", "period_start");
