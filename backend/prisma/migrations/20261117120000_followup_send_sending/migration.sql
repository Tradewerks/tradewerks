-- AlterEnum
ALTER TYPE "followup_send_status" ADD VALUE 'sending';

-- AlterTable
ALTER TABLE "followup_send" ADD COLUMN     "anchor_at" TIMESTAMP(3);

-- Legacy at-least-once sends may have left duplicate live rows for one step. Keep the
-- earliest as is and give the rest a distinct anchor_at (offset by rank so equal
-- created_at values can't collide) so the index below can build
-- without rewriting any status.
UPDATE "followup_send" fs
SET "anchor_at" = fs."created_at" + (d.rn * interval '1 millisecond')
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "enrollment_id", "step_id" ORDER BY "created_at", "id") AS rn
  FROM "followup_send"
  WHERE "status" NOT IN ('failed', 'skipped') AND "anchor_at" IS NULL
) d
WHERE fs."id" = d."id" AND d.rn > 1;

-- One live send per step per anchor. Partial and expression-based: Prisma's DSL can't
-- express it, so it lives only here. It references only pre-existing enum values, which
-- is why it can share a migration with ADD VALUE. Failed and skipped rows stay outside
-- it so a step can be retried; the anchor_at term lets a rescheduled visit send again.
CREATE UNIQUE INDEX "followup_send_one_live_per_step" ON "followup_send" ("enrollment_id", "step_id", COALESCE("anchor_at", 'epoch'::timestamp)) WHERE "status" NOT IN ('failed', 'skipped');
