-- Self-service account deletion.
-- A person deleting their own account keeps their row, scrubbed, so the org's
-- history keeps its owner; deleted_at marks it and blocks reactivation.
ALTER TABLE "dispatcher" ADD COLUMN     "deleted_at" TIMESTAMP(3);

ALTER TABLE "technician" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- The admin deleting their account deletes the organization: users are locked
-- out when this is set, and the purge sweeper retries until the org is gone.
ALTER TABLE "organization" ADD COLUMN     "deletion_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deletion_requested_at" TIMESTAMP(3);

-- Files of purged rows, written in the purge transaction and drained afterwards.
CREATE TABLE "storage_purge" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_purge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "storage_purge_created_at_idx" ON "storage_purge"("created_at");
