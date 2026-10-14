-- CreateEnum
CREATE TYPE "purchase_status" AS ENUM ('draft', 'ordered', 'partially_received', 'received', 'cancelled');

-- CreateEnum
CREATE TYPE "purchase_kind" AS ENUM ('purchase', 'refund');

-- AlterTable
ALTER TABLE "stock_movement" ADD COLUMN     "purchase_line_id" TEXT;

-- CreateTable
CREATE TABLE "purchase" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "status" "purchase_status" NOT NULL DEFAULT 'draft',
    "kind" "purchase_kind" NOT NULL DEFAULT 'purchase',
    "vendor_name" TEXT,
    "supplier_id" TEXT,
    "purchased_at" TIMESTAMP(3),
    "subtotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancellation_reason" TEXT,
    "flags" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "qb_purchase_id" TEXT,
    "qb_sync_status" "qb_sync_status" NOT NULL DEFAULT 'not_synced',
    "account_id" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_line" (
    "id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "line_total" DECIMAL(10,2) NOT NULL,
    "inventory_item_id" TEXT,
    "disposition" "line_item_disposition",
    "disposition_location" "stock_location_type",
    "disposition_vehicle_id" TEXT,
    "ocr_confidence" DECIMAL(4,3),
    "verified_at" TIMESTAMP(3),
    "visit_line_item_id" TEXT,
    "allocation_id" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_job_allocation" (
    "id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "job_visit_id" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_job_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_event" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "purchase_id" TEXT,
    "type" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_organization_id_status_idx" ON "purchase"("organization_id", "status");

-- CreateIndex
CREATE INDEX "purchase_organization_id_vendor_name_purchased_at_idx" ON "purchase"("organization_id", "vendor_name", "purchased_at");

-- CreateIndex
CREATE INDEX "purchase_supplier_id_idx" ON "purchase"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_account_id_qb_purchase_id_key" ON "purchase"("account_id", "qb_purchase_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_line_visit_line_item_id_key" ON "purchase_line"("visit_line_item_id");

-- CreateIndex
CREATE INDEX "purchase_line_purchase_id_idx" ON "purchase_line"("purchase_id");

-- CreateIndex
CREATE INDEX "purchase_line_inventory_item_id_idx" ON "purchase_line"("inventory_item_id");

-- CreateIndex
CREATE INDEX "purchase_line_disposition_vehicle_id_idx" ON "purchase_line"("disposition_vehicle_id");

-- CreateIndex
CREATE INDEX "purchase_line_allocation_id_idx" ON "purchase_line"("allocation_id");

-- CreateIndex
CREATE INDEX "purchase_job_allocation_job_id_idx" ON "purchase_job_allocation"("job_id");

-- CreateIndex
CREATE INDEX "purchase_job_allocation_job_visit_id_idx" ON "purchase_job_allocation"("job_visit_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_job_allocation_purchase_id_job_id_key" ON "purchase_job_allocation"("purchase_id", "job_id");

-- CreateIndex
CREATE INDEX "purchase_event_organization_id_at_idx" ON "purchase_event"("organization_id", "at");

-- CreateIndex
CREATE INDEX "purchase_event_purchase_id_at_idx" ON "purchase_event"("purchase_id", "at");

-- CreateIndex
CREATE INDEX "stock_movement_purchase_line_id_idx" ON "stock_movement"("purchase_line_id");

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_line" ADD CONSTRAINT "purchase_line_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_line" ADD CONSTRAINT "purchase_line_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_line" ADD CONSTRAINT "purchase_line_disposition_vehicle_id_fkey" FOREIGN KEY ("disposition_vehicle_id") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_line" ADD CONSTRAINT "purchase_line_visit_line_item_id_fkey" FOREIGN KEY ("visit_line_item_id") REFERENCES "job_visit_line_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_line" ADD CONSTRAINT "purchase_line_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "purchase_job_allocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_job_allocation" ADD CONSTRAINT "purchase_job_allocation_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_job_allocation" ADD CONSTRAINT "purchase_job_allocation_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_job_allocation" ADD CONSTRAINT "purchase_job_allocation_job_visit_id_fkey" FOREIGN KEY ("job_visit_id") REFERENCES "job_visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_event" ADD CONSTRAINT "purchase_event_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_event" ADD CONSTRAINT "purchase_event_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_purchase_line_id_fkey" FOREIGN KEY ("purchase_line_id") REFERENCES "purchase_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;
