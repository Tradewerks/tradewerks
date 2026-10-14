-- CreateTable
CREATE TABLE "upgrade_request" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "requested_by_name" TEXT NOT NULL,
    "requested_plan_key" TEXT,
    "requested_modules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolved_by_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolution_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upgrade_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "upgrade_request_status_created_at_idx" ON "upgrade_request"("status", "created_at");

-- CreateIndex
CREATE INDEX "upgrade_request_organization_id_created_at_idx" ON "upgrade_request"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "upgrade_request" ADD CONSTRAINT "upgrade_request_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One open request per organization (spec D4). Not in schema.prisma.
CREATE UNIQUE INDEX "upgrade_request_one_open" ON "upgrade_request"("organization_id") WHERE "status" = 'open';
