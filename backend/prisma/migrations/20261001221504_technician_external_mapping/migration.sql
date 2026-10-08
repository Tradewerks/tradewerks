-- CreateTable
CREATE TABLE "technician_external_mapping" (
    "id" TEXT NOT NULL,
    "technician_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "account_id" TEXT NOT NULL DEFAULT '',
    "external_id" TEXT NOT NULL,

    CONSTRAINT "technician_external_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "technician_external_mapping_technician_id_idx" ON "technician_external_mapping"("technician_id");

-- CreateIndex
CREATE UNIQUE INDEX "technician_external_mapping_provider_account_id_external_id_key" ON "technician_external_mapping"("provider", "account_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "technician_external_mapping_provider_technician_id_account__key" ON "technician_external_mapping"("provider", "technician_id", "account_id");

-- AddForeignKey
ALTER TABLE "technician_external_mapping" ADD CONSTRAINT "technician_external_mapping_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "technician"("id") ON DELETE CASCADE ON UPDATE CASCADE;
