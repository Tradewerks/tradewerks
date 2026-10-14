CREATE TYPE "inventory_import_status" AS ENUM (
    'uploaded', 'processing', 'ready_for_review', 'committing', 'committed',
    'undoing', 'undone', 'failed', 'cancelled'
);
CREATE TYPE "inventory_import_source_type" AS ENUM (
    'spreadsheet', 'csv', 'pdf', 'invoice_image', 'product_photo'
);
CREATE TYPE "inventory_import_extraction_status" AS ENUM (
    'pending', 'processing', 'extracted', 'failed', 'unsupported'
);
CREATE TYPE "inventory_import_candidate_action" AS ENUM ('create', 'update', 'skip', 'conflict');
CREATE TYPE "inventory_import_change_action" AS ENUM ('created', 'updated');

CREATE TABLE "inventory_variant_group" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "attributes" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "inventory_variant_group_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "inventory_item"
    ADD COLUMN "variant_group_id" TEXT,
    ADD COLUMN "variant_attributes" JSONB;

CREATE TABLE "inventory_import" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "created_by_id" TEXT,
    "status" "inventory_import_status" NOT NULL DEFAULT 'uploaded',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "create_count" INTEGER NOT NULL DEFAULT 0,
    "update_count" INTEGER NOT NULL DEFAULT 0,
    "skip_count" INTEGER NOT NULL DEFAULT 0,
    "conflict_count" INTEGER NOT NULL DEFAULT 0,
    "low_confidence_count" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "error_message" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "claim_token" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "financial_approved_by_id" TEXT,
    "financial_approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processing_started_at" TIMESTAMP(3),
    "ready_at" TIMESTAMP(3),
    "committed_at" TIMESTAMP(3),
    "undo_expires_at" TIMESTAMP(3),
    "undone_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "inventory_import_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_import_source" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_url" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "source_type" "inventory_import_source_type" NOT NULL,
    "extraction_status" "inventory_import_extraction_status" NOT NULL DEFAULT 'pending',
    "extraction_metadata" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "inventory_import_source_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_import_candidate" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "sheet_name" TEXT,
    "row_number" INTEGER,
    "page_number" INTEGER,
    "image_index" INTEGER,
    "ocr_bounds" JSONB,
    "raw_values" JSONB NOT NULL,
    "normalized_proposal" JSONB NOT NULL,
    "field_confidence" JSONB NOT NULL DEFAULT '{}',
    "field_evidence" JSONB NOT NULL DEFAULT '{}',
    "matching_evidence" JSONB NOT NULL DEFAULT '{}',
    "proposed_action" "inventory_import_candidate_action" NOT NULL,
    "existing_item_id" TEXT,
    "existing_quantity_at_review" DECIMAL(10,2),
    "duplicate_group" TEXT,
    "variant_group_suggestion" JSONB,
    "validation_issues" JSONB NOT NULL DEFAULT '[]',
    "user_overrides" JSONB NOT NULL DEFAULT '{}',
    "selected" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "low_confidence" BOOLEAN NOT NULL DEFAULT false,
    "financial_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "requires_financial_approval" BOOLEAN NOT NULL DEFAULT false,
    "financial_approved_by_id" TEXT,
    "financial_approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "inventory_import_candidate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_import_change" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "candidate_id" TEXT,
    "inventory_item_id" TEXT NOT NULL,
    "action" "inventory_import_change_action" NOT NULL,
    "before_snapshot" JSONB,
    "after_snapshot" JSONB NOT NULL,
    "created_mapping_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "stock_movement_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_variant_group_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inventory_import_change_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "inventory_variant_group_organization_id_display_name_idx" ON "inventory_variant_group"("organization_id", "display_name");
CREATE INDEX "inventory_item_variant_group_id_idx" ON "inventory_item"("variant_group_id");
CREATE INDEX "inventory_import_organization_id_status_idx" ON "inventory_import"("organization_id", "status");
CREATE INDEX "inventory_import_status_lease_expires_at_idx" ON "inventory_import"("status", "lease_expires_at");
CREATE INDEX "inventory_import_created_at_idx" ON "inventory_import"("created_at");
CREATE INDEX "inventory_import_source_organization_id_sha256_idx" ON "inventory_import_source"("organization_id", "sha256");
CREATE INDEX "inventory_import_source_import_id_extraction_status_idx" ON "inventory_import_source"("import_id", "extraction_status");
CREATE INDEX "inventory_import_source_sha256_idx" ON "inventory_import_source"("sha256");
CREATE INDEX "inventory_import_candidate_organization_id_import_id_idx" ON "inventory_import_candidate"("organization_id", "import_id");
CREATE INDEX "inventory_import_candidate_import_id_proposed_action_idx" ON "inventory_import_candidate"("import_id", "proposed_action");
CREATE INDEX "inventory_import_candidate_existing_item_id_idx" ON "inventory_import_candidate"("existing_item_id");
CREATE INDEX "inventory_import_candidate_duplicate_group_idx" ON "inventory_import_candidate"("duplicate_group");
CREATE INDEX "inventory_import_change_organization_id_import_id_idx" ON "inventory_import_change"("organization_id", "import_id");
CREATE INDEX "inventory_import_change_inventory_item_id_idx" ON "inventory_import_change"("inventory_item_id");
CREATE INDEX "inventory_import_change_candidate_id_idx" ON "inventory_import_change"("candidate_id");

ALTER TABLE "inventory_variant_group" ADD CONSTRAINT "inventory_variant_group_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_item" ADD CONSTRAINT "inventory_item_variant_group_id_fkey" FOREIGN KEY ("variant_group_id") REFERENCES "inventory_variant_group"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inventory_import" ADD CONSTRAINT "inventory_import_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_import" ADD CONSTRAINT "inventory_import_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "dispatcher"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inventory_import" ADD CONSTRAINT "inventory_import_financial_approved_by_id_fkey" FOREIGN KEY ("financial_approved_by_id") REFERENCES "dispatcher"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inventory_import_source" ADD CONSTRAINT "inventory_import_source_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_import_source" ADD CONSTRAINT "inventory_import_source_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "inventory_import"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_import_candidate" ADD CONSTRAINT "inventory_import_candidate_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_import_candidate" ADD CONSTRAINT "inventory_import_candidate_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "inventory_import"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_import_candidate" ADD CONSTRAINT "inventory_import_candidate_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "inventory_import_source"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_import_candidate" ADD CONSTRAINT "inventory_import_candidate_existing_item_id_fkey" FOREIGN KEY ("existing_item_id") REFERENCES "inventory_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inventory_import_candidate" ADD CONSTRAINT "inventory_import_candidate_financial_approved_by_id_fkey" FOREIGN KEY ("financial_approved_by_id") REFERENCES "dispatcher"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inventory_import_change" ADD CONSTRAINT "inventory_import_change_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_import_change" ADD CONSTRAINT "inventory_import_change_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "inventory_import"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_import_change" ADD CONSTRAINT "inventory_import_change_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "inventory_import_candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inventory_import_change" ADD CONSTRAINT "inventory_import_change_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
