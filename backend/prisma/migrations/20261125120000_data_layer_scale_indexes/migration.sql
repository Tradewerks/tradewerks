-- CreateIndex
CREATE INDEX "client_organization_id_last_activity_idx" ON "client"("organization_id", "last_activity");

-- CreateIndex
CREATE INDEX "client_organization_id_name_idx" ON "client"("organization_id", "name");

-- CreateIndex
CREATE INDEX "request_organization_id_status_idx" ON "request"("organization_id", "status");

-- CreateIndex
CREATE INDEX "quote_organization_id_status_idx" ON "quote"("organization_id", "status");

-- CreateIndex
CREATE INDEX "quote_status_expires_at_idx" ON "quote"("status", "expires_at");

-- CreateIndex
CREATE INDEX "job_visit_technician_tech_id_visit_id_idx" ON "job_visit_technician"("tech_id", "visit_id");

-- CreateIndex
CREATE INDEX "invoice_organization_id_status_idx" ON "invoice"("organization_id", "status");

-- CreateIndex
CREATE INDEX "log_organization_id_timestamp_idx" ON "log"("organization_id", "timestamp");

-- Expression index, not expressible in schema.prisma. Matches the history
-- breadcrumb predicate (logsController PARENT_ID_PATH = ["_parent_id", "new"]):
-- Prisma emits `"changes" #> ARRAY[$a, $b]::text[]`, which the planner folds to
-- this same constant path.
CREATE INDEX "log_parent_breadcrumb_idx" ON "log"("entity_type", ("changes" #> '{_parent_id,new}'));

-- The new composites lead with these columns, so the single-column indexes are
-- redundant prefixes; keeping them only slows writes (log takes the heaviest insert load).
-- DropIndex
DROP INDEX "job_visit_technician_tech_id_idx";

-- DropIndex
DROP INDEX "log_organization_id_idx";

-- DropIndex
DROP INDEX "client_organization_id_idx";
