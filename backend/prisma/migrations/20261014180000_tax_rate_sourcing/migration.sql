-- Platform tables (spec §3.1)
CREATE TABLE "tax_rate_set" (
    "id" TEXT NOT NULL,
    "composition_hash" TEXT NOT NULL,
    "state_code" TEXT NOT NULL,
    "total_rate" DECIMAL(8,6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tax_rate_set_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tax_rate_set_composition_hash_key" ON "tax_rate_set"("composition_hash");

CREATE TABLE "tax_rate_set_component" (
    "id" TEXT NOT NULL,
    "rate_set_id" TEXT NOT NULL,
    "jurisdiction_type" TEXT NOT NULL,
    "jurisdiction_name" TEXT NOT NULL,
    "jurisdiction_code" TEXT,
    "rate" DECIMAL(8,6) NOT NULL,
    "sort_order" INTEGER NOT NULL,
    CONSTRAINT "tax_rate_set_component_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tax_rate_set_component_rate_set_id_idx" ON "tax_rate_set_component"("rate_set_id");
ALTER TABLE "tax_rate_set_component" ADD CONSTRAINT "tax_rate_set_component_rate_set_id_fkey"
    FOREIGN KEY ("rate_set_id") REFERENCES "tax_rate_set"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "tax_address_resolution" (
    "id" TEXT NOT NULL,
    "address_key" TEXT NOT NULL,
    "normalized_address" TEXT NOT NULL,
    "lat" DECIMAL(9,6),
    "lng" DECIMAL(9,6),
    "rate_set_id" TEXT,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sourcing" TEXT,
    "resolved_at" TIMESTAMP(3) NOT NULL,
    "valid_until" TIMESTAMP(3) NOT NULL,
    "previous_rate_set_id" TEXT,
    CONSTRAINT "tax_address_resolution_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tax_address_resolution_address_key_key" ON "tax_address_resolution"("address_key");
CREATE INDEX "tax_address_resolution_valid_until_idx" ON "tax_address_resolution"("valid_until");
ALTER TABLE "tax_address_resolution" ADD CONSTRAINT "tax_address_resolution_rate_set_id_fkey"
    FOREIGN KEY ("rate_set_id") REFERENCES "tax_rate_set"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Org settings (spec §3.2). The CHECK backs the Zod enum, like organization_measurement_system_chk.
ALTER TABLE "organization" ADD COLUMN "tax_mode" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "organization" ADD COLUMN "tax_registered_states" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "organization" ADD CONSTRAINT "organization_tax_mode_chk"
    CHECK ("tax_mode" IN ('auto', 'manual'));

-- Document provenance (spec §3.3)
ALTER TABLE "quote" ADD COLUMN "tax_source" TEXT,
    ADD COLUMN "tax_resolution_id" TEXT,
    ADD COLUMN "tax_needs_review" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "tax_review_ack_by" TEXT,
    ADD COLUMN "tax_review_ack_at" TIMESTAMP(3);
ALTER TABLE "job" ADD COLUMN "tax_source" TEXT,
    ADD COLUMN "tax_resolution_id" TEXT,
    ADD COLUMN "tax_needs_review" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "tax_review_ack_by" TEXT,
    ADD COLUMN "tax_review_ack_at" TIMESTAMP(3);
ALTER TABLE "invoice" ADD COLUMN "tax_source" TEXT,
    ADD COLUMN "tax_resolution_id" TEXT,
    ADD COLUMN "tax_needs_review" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "tax_review_ack_by" TEXT,
    ADD COLUMN "tax_review_ack_at" TIMESTAMP(3);
CREATE INDEX "quote_tax_resolution_id_idx" ON "quote"("tax_resolution_id");
CREATE INDEX "job_tax_resolution_id_idx" ON "job"("tax_resolution_id");
CREATE INDEX "invoice_tax_resolution_id_idx" ON "invoice"("tax_resolution_id");
ALTER TABLE "quote" ADD CONSTRAINT "quote_tax_resolution_id_fkey" FOREIGN KEY ("tax_resolution_id")
    REFERENCES "tax_address_resolution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "job" ADD CONSTRAINT "job_tax_resolution_id_fkey" FOREIGN KEY ("tax_resolution_id")
    REFERENCES "tax_address_resolution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_tax_resolution_id_fkey" FOREIGN KEY ("tax_resolution_id")
    REFERENCES "tax_address_resolution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Precision (spec §3.5): non-breaking widening, 4 → 6 decimal places
ALTER TABLE "tax_rate" ALTER COLUMN "rate" SET DATA TYPE DECIMAL(8,6);
ALTER TABLE "organization" ALTER COLUMN "tax_rate" SET DATA TYPE DECIMAL(8,6);
ALTER TABLE "client" ALTER COLUMN "tax_rate" SET DATA TYPE DECIMAL(8,6);
ALTER TABLE "quote" ALTER COLUMN "tax_rate" SET DATA TYPE DECIMAL(8,6);
ALTER TABLE "job" ALTER COLUMN "tax_rate" SET DATA TYPE DECIMAL(8,6);
ALTER TABLE "job_visit" ALTER COLUMN "tax_rate" SET DATA TYPE DECIMAL(8,6);
ALTER TABLE "invoice" ALTER COLUMN "tax_rate" SET DATA TYPE DECIMAL(8,6);
