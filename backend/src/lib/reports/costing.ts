import { getScopedDb } from "../context.js";
import { CONSUMPTION_MOVEMENT_PREDICATE, CONSUMPTION_SIGNED_QTY } from "../inventory.js";

export type CostSource = "wac" | "fallback_current_cost" | "fallback_mixed_unit" | "no_cost_data";

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
					WHEN wac_value IS NOT NULL THEN wac_value
					WHEN distinct_units > 1 THEN COALESCE(item_current_cost, 0)
					WHEN item_current_cost IS NOT NULL THEN item_current_cost
					ELSE 0
				END::float AS "unitCostBasis",
				CASE
					WHEN wac_value IS NOT NULL THEN 'wac'
					WHEN distinct_units > 1 THEN 'fallback_mixed_unit'
					WHEN item_current_cost IS NOT NULL THEN 'fallback_current_cost'
					ELSE 'no_cost_data'
				END AS "costSource"
			FROM priced
		)
		SELECT *, ("qtyConsumed" * "unitCostBasis")::float AS "totalCost"
		FROM costed
		ORDER BY "consumedAt" ASC
		LIMIT ${ROW_CAP + 1}
	`;

	const truncated = rows.length > ROW_CAP;
	return { rows: truncated ? rows.slice(0, ROW_CAP) : rows, truncated };
}
