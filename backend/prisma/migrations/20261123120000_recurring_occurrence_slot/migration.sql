-- Recurring occurrence slot identity.
-- original_start_at = the rule-computed slot a row fills. It never moves on reschedule, so
-- (recurring_plan_id, original_start_at) is the idempotency key for generation.

-- 1. New columns (original_start_at nullable until backfilled)
ALTER TABLE "recurring_occurrence" ADD COLUMN "original_start_at" TIMESTAMP(3);
ALTER TABLE "recurring_occurrence" ADD COLUMN "slot_verified" BOOLEAN NOT NULL DEFAULT true;

-- 2. Backfill legacy rows. occurrence_start_at may already have been rescheduled away from the
--    computed slot, so these rows are flagged unverified; the reconcile pass fixes them up.
UPDATE "recurring_occurrence"
SET "original_start_at" = "occurrence_start_at",
    "slot_verified" = false;

-- 3a. Dedupe: drop surplus duplicates that carry nothing (planned, no visit).
--     Survivor per slot (rn = 1) prefers a row with a visit, then a non-planned row, then oldest.
WITH ranked AS (
	SELECT "id", "status", "job_visit_id",
	       ROW_NUMBER() OVER (
		       PARTITION BY "recurring_plan_id", "original_start_at"
		       ORDER BY ("job_visit_id" IS NOT NULL) DESC,
		                ("status" <> 'planned') DESC,
		                "created_at" ASC,
		                "id" ASC
	       ) AS rn
	FROM "recurring_occurrence"
)
DELETE FROM "recurring_occurrence" o
USING ranked r
WHERE o."id" = r."id"
  AND r.rn > 1
  AND r."status" = 'planned'
  AND r."job_visit_id" IS NULL;

-- 3b. Remaining duplicates have history (a visit or a non-planned status) and must be kept.
--     Nudge each one by (rn - 1) ms so the unique index can be built. Computed slots are whole
--     minutes (rule times are HH:MM), so a millisecond-offset slot can never match a computed
--     slot: generation will never treat these rows as filling a real slot.
WITH ranked AS (
	SELECT "id",
	       ROW_NUMBER() OVER (
		       PARTITION BY "recurring_plan_id", "original_start_at"
		       ORDER BY ("job_visit_id" IS NOT NULL) DESC,
		                ("status" <> 'planned') DESC,
		                "created_at" ASC,
		                "id" ASC
	       ) AS rn
	FROM "recurring_occurrence"
)
UPDATE "recurring_occurrence" o
SET "original_start_at" = o."original_start_at" + (r.rn - 1) * interval '1 millisecond'
FROM ranked r
WHERE o."id" = r."id"
  AND r.rn > 1;

-- 4. Enforce
ALTER TABLE "recurring_occurrence" ALTER COLUMN "original_start_at" SET NOT NULL;

CREATE UNIQUE INDEX "recurring_occurrence_recurring_plan_id_original_start_at_key" ON "recurring_occurrence"("recurring_plan_id", "original_start_at");

-- ---------------------------------------------------------------------------------------------
-- Duplicate-fixture test, run on scratch DB hvac_seedcheck after deploying up to
-- 20261122120000_review_and_share and before this migration. Verified 2026-11-23 result:
--   occ-a1 kept   (2026-01-05 15:00:00.000)  -- planned/no-visit survivor (older)
--   occ-a2 DELETED                            -- planned/no-visit duplicate
--   occ-b1 kept   (2026-01-12 15:00:00.000)  -- both have visits; older survives the slot
--   occ-b2 kept   (2026-01-12 15:00:00.001)  -- offset 1 ms, can never match a computed slot
--   occ-c1 kept   (2026-01-19 15:00:00.000)  -- no duplicate, untouched
--   all rows slot_verified = false; plan-t3 timezone realigned to America/New_York by M2.
--
-- INSERT INTO organization (id, name, timezone) VALUES ('org-t3', 'T3 Org', 'America/New_York');
-- INSERT INTO client (id, organization_id, name, address, coords, updated_at)
--   VALUES ('cli-t3', 'org-t3', 'T3 Client', '1 Main St', '{}', now());
-- INSERT INTO recurring_plan (id, organization_id, client_id, name, description, address,
--     starts_at, timezone, updated_at)
--   VALUES ('plan-t3', 'org-t3', 'cli-t3', 'T3 Plan', '', '1 Main St', '2026-01-01',
--     'America/Chicago', now());
-- INSERT INTO job (id, organization_id, client_id, name, job_number, address, coords,
--     description, recurring_plan_id, updated_at)
--   VALUES ('job-t3', 'org-t3', 'cli-t3', 'T3 Job', 'J-T3', '1 Main St', '{}', '', 'plan-t3',
--     now());
-- INSERT INTO job_visit (id, job_id, scheduled_start_at, scheduled_end_at, arrival_constraint,
--     finish_constraint, updated_at)
--   VALUES ('vis-t3-1', 'job-t3', '2026-01-12 15:00', '2026-01-12 16:00', 'at', 'when_done', now()),
--          ('vis-t3-2', 'job-t3', '2026-01-12 15:00', '2026-01-12 16:00', 'at', 'when_done', now());
-- INSERT INTO recurring_occurrence (id, recurring_plan_id, occurrence_start_at,
--     occurrence_end_at, status, job_visit_id, created_at) VALUES
--   ('occ-a1', 'plan-t3', '2026-01-05 15:00', '2026-01-05 16:00', 'planned', NULL, '2025-12-01'),
--   ('occ-a2', 'plan-t3', '2026-01-05 15:00', '2026-01-05 16:00', 'planned', NULL, '2025-12-02'),
--   ('occ-b1', 'plan-t3', '2026-01-12 15:00', '2026-01-12 16:00', 'generated', 'vis-t3-1',
--     '2025-12-01'),
--   ('occ-b2', 'plan-t3', '2026-01-12 15:00', '2026-01-12 16:00', 'generated', 'vis-t3-2',
--     '2025-12-02'),
--   ('occ-c1', 'plan-t3', '2026-01-19 15:00', '2026-01-19 16:00', 'planned', NULL, '2025-12-01');
--
-- SELECT id, status, job_visit_id, occurrence_start_at,
--        to_char(original_start_at, 'YYYY-MM-DD HH24:MI:SS.MS'), slot_verified
--   FROM recurring_occurrence WHERE recurring_plan_id = 'plan-t3' ORDER BY id;
-- ---------------------------------------------------------------------------------------------
