-- Lock window. Prisma sends this file as one implicit transaction, so every
-- lock below is held until the last statement commits:
--   * ADD COLUMN with a constant DEFAULT is metadata-only (PostgreSQL 11+).
--   * Each CREATE INDEX holds a SHARE lock on "invoice": reads continue, but
--     every invoice insert/update/delete (sends, payments, edits) waits for
--     the build.
--   * Each ADD CONSTRAINT ... FOREIGN KEY holds SHARE ROW EXCLUSIVE on "invoice"
--     while it scans it. The new columns are all NULL, so the scan is cheap.
-- Splitting the FKs into NOT VALID + VALIDATE buys nothing inside a single
-- transaction. For a tenant large enough that the index builds matter, build
-- both indexes out of band first with CREATE INDEX CONCURRENTLY under the same
-- names; IF NOT EXISTS below then skips them.

-- AlterTable
ALTER TABLE "invoice" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "previous_invoice_id" TEXT,
ADD COLUMN     "adjusts_invoice_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_previous_invoice_id_key" ON "invoice"("previous_invoice_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "invoice_adjusts_invoice_id_idx" ON "invoice"("adjusts_invoice_id");

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_previous_invoice_id_fkey" FOREIGN KEY ("previous_invoice_id") REFERENCES "invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_adjusts_invoice_id_fkey" FOREIGN KEY ("adjusts_invoice_id") REFERENCES "invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- An adjustment may not adjust itself; chains stay one level deep.
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_adjustment_not_self"
  CHECK (adjusts_invoice_id IS NULL OR adjusts_invoice_id <> id);
