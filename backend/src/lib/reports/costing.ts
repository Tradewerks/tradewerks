import { getScopedDb } from "../context.js";
import { CONSUMPTION_MOVEMENT_PREDICATE, CONSUMPTION_SIGNED_QTY } from "../inventory.js";

export type CostSource = "actual" | "wac" | "fallback_current_cost" | "fallback_mixed_unit" | "no_cost_data";

export interface ConsumptionCostRow {
	movementId: string;
	visitId: string;
	jobId: string;
	clientId: string;
	inventoryItemId: string;
	consumedAt: Date;
	reason: "parts_used" | "direct_consumption" | "reversal";
	unit: string;
	qtyConsumed: number;    // negative when reversal
	unitCostBasis: number;  // 0 only when costSource == no_cost_data
	totalCost: number;
	costSource: CostSource;
}

// Mirrors reportsController.ts's REPORT_ROW_CAP
const ROW_CAP = 10000;

/**
 * Prices every inventory-consumption event (parts used on a job, direct
 * consumption, and their reversals) at point-in-time weighted-average cost
 * (WAC), derived from `stock_movement` receipt history — never from the
 * item's current `cost` snapshot except as a fallback.
 *
 * Returns event-level rows, deliberately not pre-grouped, so callers (COGS
 * by Job, COGS by Item) reduce the same row set in JS rather than each
 * running their own query.
 */
export async function computeConsumptionCosts(
	orgId: string,
	opts: { startDate?: Date; endDate?: Date } = {},
): Promise<{ rows: ConsumptionCostRow[]; truncated: boolean }> {
	const { startDate, endDate } = opts;
	const sdb = getScopedDb(orgId);

	const rows = await sdb.$queryRaw<ConsumptionCostRow[]>`
		WITH consumption_events AS (
			SELECT
				sm.id AS "movementId",
				sm.visit_id AS "visitId",
				jv.job_id AS "jobId",
				j.client_id AS "clientId",
				sm.inventory_item_id AS "inventoryItemId",
				sm.created_at AS "consumedAt",
				sm.reason AS "reason",
				sm.unit AS "unit",
				sm.unit_cost AS "rowUnitCost",
				(${CONSUMPTION_SIGNED_QTY})::float AS "qtyConsumed"
			FROM stock_movement sm
			JOIN job_visit jv ON jv.id = sm.visit_id
			JOIN job j ON j.id = jv.job_id
			WHERE sm.organization_id = ${orgId}
				AND (${CONSUMPTION_MOVEMENT_PREDICATE})
				AND sm.created_at >= COALESCE(${startDate ?? null}, '-infinity'::timestamptz)
				AND sm.created_at <  COALESCE(${endDate ?? null},   'infinity'::timestamptz)
		),
		relevant_items AS (
			SELECT DISTINCT "inventoryItemId" FROM consumption_events
		),
		-- Cumulative receipt qty/spend per item, as of each receipt row, so the
		-- LATERAL join below can pick "running totals as of the last receipt at
		-- or before this consumption event" without re-summing per row.
		receipt_wac AS (
			SELECT
				sm.inventory_item_id,
				sm.created_at,
				sm.id,
				SUM(sm.qty) OVER w AS running_qty,
				SUM(sm.qty * sm.unit_cost) OVER w AS running_spend
			FROM stock_movement sm
			JOIN relevant_items ri ON ri."inventoryItemId" = sm.inventory_item_id
			WHERE sm.organization_id = ${orgId}
				AND sm.reason IN ('receive', 'supplier_purchase')
				AND sm.unit_cost IS NOT NULL
				-- A field purchase consumed on the job never entered stock: counting
				-- it as a receipt spreads its (usually premium) price across WAC.
				AND sm.to_location_type <> 'consumed'
			WINDOW w AS (
				PARTITION BY sm.inventory_item_id
				ORDER BY sm.created_at, sm.id
				ROWS UNBOUNDED PRECEDING
			)
		),
		-- Postgres rejects DISTINCT inside an OVER() window aggregate, so this is
		-- a plain GROUP BY instead of a column on receipt_wac above.
		item_unit_counts AS (
			SELECT sm.inventory_item_id, COUNT(DISTINCT sm.unit) AS distinct_units
			FROM stock_movement sm
			JOIN relevant_items ri ON ri."inventoryItemId" = sm.inventory_item_id
			WHERE sm.organization_id = ${orgId}
				AND sm.reason IN ('receive', 'supplier_purchase')
				AND sm.unit_cost IS NOT NULL
				AND sm.to_location_type <> 'consumed'
			GROUP BY sm.inventory_item_id
		),
		priced AS (
			SELECT
				ce.*,
				ii.cost AS item_current_cost,
				iuc.distinct_units,
				-- Bail out to a fallback (below) rather than average across units,
				-- same "mixed units = don't trust the number" rule getItemPriceHistory uses.
				CASE
					WHEN iuc.distinct_units = 1 AND rw.running_qty IS NOT NULL AND rw.running_qty <> 0
						THEN rw.running_spend / rw.running_qty
					ELSE NULL
				END AS wac_value
			FROM consumption_events ce
			JOIN inventory_item ii ON ii.id = ce."inventoryItemId"
			LEFT JOIN item_unit_counts iuc ON iuc.inventory_item_id = ce."inventoryItemId"
			LEFT JOIN LATERAL (
				SELECT running_qty, running_spend
				FROM receipt_wac rw
				WHERE rw.inventory_item_id = ce."inventoryItemId"
					AND (rw.created_at, rw.id) <= (ce."consumedAt", ce."movementId")
				ORDER BY rw.created_at DESC, rw.id DESC
				LIMIT 1
			) rw ON true
		),
		costed AS (
			SELECT
				"movementId", "visitId", "jobId", "clientId", "inventoryItemId",
				"consumedAt", "reason", "unit", "qtyConsumed",
				CASE
					WHEN "rowUnitCost" IS NOT NULL THEN "rowUnitCost"
					WHEN wac_value IS NOT NULL THEN wac_value
					ELSE COALESCE(item_current_cost, 0)
				END::float AS "unitCostBasis",
				-- The row's own unit_cost is what was actually paid, so it beats any
				-- average. Only field purchases carry one; parts_used never sets it.
				-- No current cost outranks the mixed-unit fallback: the basis is 0
				-- either way, and calling that a price makes it count as costed.
				CASE
					WHEN "rowUnitCost" IS NOT NULL THEN 'actual'
					WHEN wac_value IS NOT NULL THEN 'wac'
					WHEN item_current_cost IS NULL THEN 'no_cost_data'
					WHEN distinct_units > 1 THEN 'fallback_mixed_unit'
					ELSE 'fallback_current_cost'
				END AS "costSource"
			FROM priced
		)
		SELECT *, ("qtyConsumed" * "unitCostBasis")::float AS "totalCost"
		FROM costed
		ORDER BY "consumedAt" DESC, "movementId" DESC
		LIMIT ${ROW_CAP + 1}
	`;

	// Newest first above so the cap drops the OLDEST events: dropping the newest
	// stripped cost from the very jobs whose revenue is in the window, which
	// overstates profit. Flipped back to chronological for callers.
	const truncated = rows.length > ROW_CAP;
	return { rows: (truncated ? rows.slice(0, ROW_CAP) : rows).reverse(), truncated };
}

export interface JobDirectCostRow {
	jobId: string;
	hours: number;
	laborCost: number;
	/** Hours worked by a technician with no cost_rate — the job's labor is unknowable, not cheap. */
	unratedHours: number;
	miles: number;
	/** Visits attached to the job at all, so "no miles" can be told from "no visits". */
	visitCount: number;
}

/**
 * Per-job labor hours, labor cost and driven miles — the direct inputs to net
 * profit, beside the material costs above.
 *
 * Job-LIFETIME, with no date filter, deliberately: it sits next to
 * `getCogsByJobReport(undefined, undefined, orgId)` and the two must share a
 * convention or the columns cannot be compared on one row.
 *
 * Raw SQL bypasses `getScopedDb` entirely, so both CTEs are scoped by hand
 * through `job.organization_id` — the same discipline as the query above.
 * Every aggregate is cast `::float`: a Prisma Decimal arrives as a string and
 * `num()` silently turns those into 0, which yields a correct-looking table
 * over a zeroed summary.
 */
export async function computeJobDirectCosts(orgId: string): Promise<JobDirectCostRow[]> {
	const sdb = getScopedDb(orgId);

	return sdb.$queryRaw<JobDirectCostRow[]>`
		WITH labor AS (
			SELECT
				jv.job_id AS "jobId",
				SUM(COALESCE(e.hours_worked, 0))::float AS "hours",
				SUM(COALESCE(e.hours_worked, 0) * COALESCE(t.cost_rate, 0))::float AS "laborCost",
				SUM(CASE WHEN t.cost_rate IS NULL THEN COALESCE(e.hours_worked, 0) ELSE 0 END)::float
					AS "unratedHours"
			FROM visit_tech_time_entry e
			JOIN job_visit jv ON jv.id = e.visit_id
			JOIN job j        ON j.id = jv.job_id
			JOIN technician t ON t.id = e.tech_id
			WHERE j.organization_id = ${orgId}
			GROUP BY jv.job_id
		),
		travel AS (
			SELECT
				jv.job_id AS "jobId",
				SUM(COALESCE(jv.estimated_drive_miles, 0)
					+ COALESCE(jv.estimated_return_drive_miles, 0))::float AS "miles",
				COUNT(*)::int AS "visitCount"
			FROM job_visit jv
			JOIN job j ON j.id = jv.job_id
			WHERE j.organization_id = ${orgId}
			GROUP BY jv.job_id
		)
		-- FULL OUTER: a job can have visits with no time entries, or (via a
		-- force-closed entry) entries on a visit that was since deleted.
		SELECT
			COALESCE(l."jobId", v."jobId")  AS "jobId",
			COALESCE(l."hours", 0)          AS "hours",
			COALESCE(l."laborCost", 0)      AS "laborCost",
			COALESCE(l."unratedHours", 0)   AS "unratedHours",
			COALESCE(v."miles", 0)          AS "miles",
			COALESCE(v."visitCount", 0)     AS "visitCount"
		FROM labor l
		FULL OUTER JOIN travel v ON v."jobId" = l."jobId"
	`;
}
