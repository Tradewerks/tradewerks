import { getScopedDb } from "../lib/context.js";
import { resolveVendorPrice } from "../services/suppliers.js";
import {
	normalizedMonthly,
	planPerPeriodAmount,
	type BillingBasis,
	type ScheduleFrequency,
} from "../lib/reports/recurringRevenue.js";
import { Prisma } from "../../generated/prisma/client.js";
import { centsToDollars, dollarsToCents, type TaxSnapshot } from "../services/taxEngine.js";
import { roundHalfUpSymmetric } from "../services/tax/rounding.js";
import { qbAstTaxCents, roundingFor } from "../services/tax/snapshot.js";
import {
	getStockStatus,
	unitBasis,
	type UnitBasis,
	CONSUMPTION_MOVEMENT_PREDICATE,
	CONSUMPTION_SIGNED_QTY,
} from "../lib/inventory.js";
import {
	buildSqlParts,
	type ColumnDef,
	type ColumnMap,
	type DefaultOrder,
} from "../lib/reports/pushdown.js";
import type { PaginateParams } from "../lib/reports/filterEngine.js";
import { round2 } from "../lib/reports/numbers.js";
import { getOrgRealmId } from "../services/quickbooksService.js";
import { log } from "../services/appLogger.js";
import { createErrorResponse, ErrorCodes, httpError } from "../types/responses.js";
import {
	computeConsumptionCosts,
	computeJobDirectCosts,
	ConsumptionCostRow,
} from "../lib/reports/costing.js";
import { buildShiftSegments } from "./timesheetController.js";

// Upper bound on rows pulled into memory for the in-JS report aggregations
const REPORT_ROW_CAP = 10000;

// ============================================================================
// DATE RANGE PARSING (shared by every dated report)
// ============================================================================

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Parses a date query param, rejecting garbage with a 400 instead of letting an
// Invalid Date reach Prisma/SQL and surface as a 500. No normalization.
export const reportInstant = (value: string): Date => {
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) {
		throw httpError(400, ErrorCodes.VALIDATION_ERROR, `Invalid date: ${value}`);
	}
	return d;
};

// One report bound. A bare `YYYY-MM-DD` means "that whole UTC day", so it is
// widened to the day's start or end. Anything else (the frontend sends full ISO
// instants for the user's local range) is used exactly as sent — flooring those
// to UTC day bounds stretched every window by up to a day at each end for any
// non-UTC user and double-counted rows at the seams.
export const parseReportDate = (value: string, edge: "start" | "end"): Date => {
	const d = reportInstant(value);
	if (DATE_ONLY_RE.test(value)) {
		if (edge === "start") d.setUTCHours(0, 0, 0, 0);
		else d.setUTCHours(23, 59, 59, 999);
	}
	return d;
};

export const buildDateFilter = (startDate?: string, endDate?: string) => {
	const filter: { gte?: Date; lte?: Date } = {};
	if (startDate) filter.gte = parseReportDate(startDate, "start");
	if (endDate) filter.lte = parseReportDate(endDate, "end");
	return filter;
};

// Only text is searchable
const t = (expr: string): ColumnDef => ({ expr, type: "text", filterable: true, sortable: true, searchable: true });
const n = (expr: string): ColumnDef => ({ expr, type: "number", filterable: true, sortable: true, searchable: false });
const cur = (expr: string): ColumnDef => ({ expr, type: "currency", filterable: true, sortable: true, searchable: false });
const dt = (expr: string): ColumnDef => ({ expr, type: "date", filterable: true, sortable: true, searchable: false });

export interface PageResult<T> {
	rows: T[];
	total: number;
	page: number;
	pageSize: number;
}

// SQL id-prefilter: fetch a page of ids (+ total) via WHERE/ORDER/LIMIT, then
// hydrate just those ids through Prisma and re-order to match. Returns null if
// the request can't be expressed in SQL → caller uses the in-memory fallback.
async function runIdPrefilter<T>(opts: {
	sdb: ReturnType<typeof getScopedDb>;
	from: string;
	baseWhere: string;
	baseParams: unknown[];
	idExpr: string;
	columns: ColumnMap;
	defaultOrder: DefaultOrder;
	params: PaginateParams;
	hydrate: (ids: string[]) => Promise<T[]>;
	rowId: (row: T) => string;
}): Promise<(PageResult<T> & { whereSql: string; whereParams: unknown[] }) | null> {
	const parts = buildSqlParts(opts.params, opts.columns, {
		defaultOrder: opts.defaultOrder,
		idExpr: opts.idExpr,
		paramOffset: opts.baseParams.length,
	});
	if (!parts) return null;

	const whereFull = opts.baseWhere + (parts.whereSql ? ` AND ${parts.whereSql}` : "");
	const whereParams = [...opts.baseParams, ...parts.whereParams];
	const idSql = `SELECT ${opts.idExpr} AS id FROM ${opts.from} WHERE ${whereFull} ORDER BY ${parts.orderSql} LIMIT $${whereParams.length + 1} OFFSET $${whereParams.length + 2}`;
	const countSql = `SELECT COUNT(*)::int AS count FROM ${opts.from} WHERE ${whereFull}`;

	const [idRows, countRows] = await Promise.all([
		opts.sdb.$queryRawUnsafe<{ id: string }[]>(idSql, ...whereParams, parts.limit, parts.offset),
		opts.sdb.$queryRawUnsafe<{ count: number }[]>(countSql, ...whereParams),
	]);

	const ids = idRows.map((r) => r.id);
	const hydrated = await opts.hydrate(ids);
	const byId = new Map(hydrated.map((r) => [opts.rowId(r), r]));
	const rows = ids.map((id) => byId.get(id)).filter((r): r is T => r !== undefined);
	return {
		rows,
		total: countRows[0]?.count ?? 0,
		page: parts.page,
		pageSize: parts.pageSize,
		// base + dynamic, so callers can run matching aggregates
		whereSql: whereFull,
		whereParams,
	};
}

// ============================================================================
// OVERVIEW METRICS
// ============================================================================

export const getOverviewMetrics = async (
	startDate: string,
	endDate: string,
	organizationId: string,
) => {
	const start = reportInstant(startDate);
	const end = reportInstant(endDate);
	const sdb = getScopedDb(organizationId);
	// Last Month
	const previousStart = new Date(start.getFullYear(), start.getMonth() - 1, 1);
	const previousEnd = new Date(start.getFullYear(), start.getMonth(), 0, 23, 59, 59, 999);

	// Current period
	const [
		avgResponseTimeResult,
		convertedQuotes,
		totalQuotes,
		approvedOfCreated,
		newOneOffJobs,
		newRecurringJobs,
		avgJobValue,
		grossRevenueResult,
	] = await Promise.all([
		sdb.$queryRaw<[{ avg_days: number | null }]>`
			SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (q.created_at - r.created_at)) / 86400), 0)::float AS avg_days
			FROM quote q
			JOIN request r ON r.id = q.request_id
			WHERE q.created_at >= ${start}
				AND q.created_at <= ${end}
				AND q.request_id IS NOT NULL
				AND q.organization_id = ${organizationId}
		`,
		sdb.quote.count({
			where: {
				organization_id: organizationId,
				status: "Approved",
				approved_at: { gte: start, lte: end },
			},
		}),
		sdb.quote.count({
			where: {
				organization_id: organizationId,
				created_at: { gte: start, lte: end },
			},
		}),
		// Same cohort as totalQuotes, so the rate can't pass 100%.
		sdb.quote.count({
			where: {
				organization_id: organizationId,
				status: "Approved",
				created_at: { gte: start, lte: end },
			},
		}),
		sdb.job.count({
			where: {
				organization_id: organizationId,
				recurring_plan_id: null,
				created_at: { gte: start, lte: end },
			},
		}),
		sdb.job.count({
			where: {
				organization_id: organizationId,
				recurring_plan_id: { not: null },
				created_at: { gte: start, lte: end },
			},
		}),
		sdb.job.aggregate({
			where: {
				organization_id: organizationId,
				created_at: { gte: start, lte: end },
			},
			_avg: { estimated_total: true },
		}),
		sdb.job_visit.aggregate({
			where: {
				status: "Completed",
				actual_end_at: { gte: start, lte: end },
				job: { organization_id: organizationId },
			},
			_sum: { total: true },
		}),
	]);

	// Last Month
	const [
		prevAvgResponseTimeResult,
		prevConvertedQuotes,
		prevTotalQuotes,
		prevApprovedOfCreated,
		prevOneOffJobs,
		prevRecurringJobs,
		prevAvgJobValue,
		prevGrossRevenueResult,
	] = await Promise.all([
		sdb.$queryRaw<[{ avg_days: number | null }]>`
			SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (q.created_at - r.created_at)) / 86400), 0)::float AS avg_days
			FROM quote q
			JOIN request r ON r.id = q.request_id
			WHERE q.created_at >= ${previousStart}
				AND q.created_at <= ${previousEnd}
				AND q.request_id IS NOT NULL
				AND q.organization_id = ${organizationId}
		`,
		sdb.quote.count({
			where: {
				organization_id: organizationId,
				status: "Approved",
				approved_at: { gte: previousStart, lte: previousEnd },
			},
		}),
		sdb.quote.count({
			where: {
				organization_id: organizationId,
				created_at: { gte: previousStart, lte: previousEnd },
			},
		}),
		sdb.quote.count({
			where: {
				organization_id: organizationId,
				status: "Approved",
				created_at: { gte: previousStart, lte: previousEnd },
			},
		}),
		sdb.job.count({
			where: {
				organization_id: organizationId,
				recurring_plan_id: null,
				created_at: { gte: previousStart, lte: previousEnd },
			},
		}),
		sdb.job.count({
			where: {
				organization_id: organizationId,
				recurring_plan_id: { not: null },
				created_at: { gte: previousStart, lte: previousEnd },
			},
		}),
		sdb.job.aggregate({
			where: {
				organization_id: organizationId,
				created_at: { gte: previousStart, lte: previousEnd },
			},
			_avg: { estimated_total: true },
		}),
		sdb.job_visit.aggregate({
			where: {
				status: "Completed",
				actual_end_at: { gte: previousStart, lte: previousEnd },
				job: { organization_id: organizationId },
			},
			_sum: { total: true },
		}),
	]);

	// Calculates all unscheduled jobs
	const backlogResult = await sdb.job.aggregate({
		where: { organization_id: organizationId, status: "Unscheduled" },
		_sum: { estimated_total: true },
	});

	const calcChange = (current: number, previous: number): number => {
		if (previous === 0) return current > 0 ? 100 : 0;
		return Math.round(((current - previous) / previous) * 100);
	};

	const convRate =
		totalQuotes > 0
			? Math.round((approvedOfCreated / totalQuotes) * 100)
			: 0;
	const prevConvRate =
		prevTotalQuotes > 0
			? Math.round((prevApprovedOfCreated / prevTotalQuotes) * 100)
			: 0;

	const avgValue = Number(avgJobValue._avg.estimated_total ?? 0);
	const prevAvgValue = Number(prevAvgJobValue._avg.estimated_total ?? 0);

	const grossRevenue = Number(grossRevenueResult._sum.total ?? 0);
	const prevGrossRevenue = Number(prevGrossRevenueResult._sum.total ?? 0);
	const backlogValue = Number(backlogResult._sum.estimated_total ?? 0);

	const avgResponseDays = Math.round((avgResponseTimeResult[0]?.avg_days ?? 0) * 10) / 10;
	const prevAvgResponseDays = Math.round((prevAvgResponseTimeResult[0]?.avg_days ?? 0) * 10) / 10;

	return {
		periodStart: start.toISOString(),
		periodEnd: end.toISOString(),
		previousPeriodStart: previousStart.toISOString(),
		previousPeriodEnd: previousEnd.toISOString(),
		grossRevenue: {
			value: Math.round(grossRevenue * 100) / 100,
			previousValue: Math.round(prevGrossRevenue * 100) / 100,
			changePercent: calcChange(grossRevenue, prevGrossRevenue),
		},
		avgResponseTime: {
			value: avgResponseDays,
			previousValue: prevAvgResponseDays,
			changePercent: calcChange(avgResponseDays, prevAvgResponseDays),
		},
		convertedQuotes: {
			value: convertedQuotes,
			previousValue: prevConvertedQuotes,
			changePercent: calcChange(convertedQuotes, prevConvertedQuotes),
		},
		conversionRate: {
			value: convRate,
			previousValue: prevConvRate,
			changePercent: calcChange(convRate, prevConvRate),
		},
		newOneOffJobs: {
			value: newOneOffJobs,
			previousValue: prevOneOffJobs,
			changePercent: calcChange(newOneOffJobs, prevOneOffJobs),
		},
		newRecurringJobs: {
			value: newRecurringJobs,
			previousValue: prevRecurringJobs,
			changePercent: calcChange(newRecurringJobs, prevRecurringJobs),
		},
		avgJobValue: {
			value: Math.round(avgValue),
			previousValue: Math.round(prevAvgValue),
			changePercent: calcChange(avgValue, prevAvgValue),
		},
		unscheduledBacklog: {
			value: Math.round(backlogValue * 100) / 100,
			previousValue: 0,
			changePercent: 0,
		},
	};
};

// ============================================================================
// REVENUE YEAR TO DATE
// ============================================================================

interface MonthlyRevenueRow {
	month: number;
	year: number;
	total: string;
}

export const getRevenueYTD = async (
	organizationId: string,
	year?: number,
) => {
	const currentYear = year ?? new Date().getFullYear();
	const previousYear = currentYear - 1;

	const sdb = getScopedDb(organizationId);

	const previousYearStart = new Date(`${previousYear}-01-01T00:00:00.000Z`);
	const currentYearEnd = new Date(`${currentYear + 1}-01-01T00:00:00.000Z`);

	const [monthlyRevenue, monthlyForecast] = await Promise.all([
		sdb.$queryRaw<MonthlyRevenueRow[]>`
			SELECT
				EXTRACT(MONTH FROM jv.actual_end_at)::int AS month,
				EXTRACT(YEAR FROM jv.actual_end_at)::int AS year,
				SUM(jv.total)::text AS total
			FROM job_visit jv
			JOIN job j ON j.id = jv.job_id
			WHERE jv.status = 'Completed'
				AND jv.actual_end_at >= ${previousYearStart}
				AND jv.actual_end_at < ${currentYearEnd}
				AND j.organization_id = ${organizationId}
			GROUP BY year, month
			ORDER BY year, month
		`,
		sdb.$queryRaw<MonthlyRevenueRow[]>`
			SELECT
				EXTRACT(MONTH FROM jv.scheduled_start_at)::int AS month,
				EXTRACT(YEAR FROM jv.scheduled_start_at)::int AS year,
				SUM(jv.total)::text AS total
			FROM job_visit jv
			JOIN job j ON j.id = jv.job_id
			WHERE jv.status IN ('Scheduled', 'InProgress')
				AND jv.scheduled_start_at >= ${previousYearStart}
				AND jv.scheduled_start_at < ${currentYearEnd}
				AND j.organization_id = ${organizationId}
			GROUP BY year, month
			ORDER BY year, month
		`,
	]);

	const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul",
		"Aug","Sep","Oct","Nov","Dec",
	];

	const findTotal = (
		rows: MonthlyRevenueRow[],
		y: number,
		m: number,
	): number => {
		const row = rows.find((r) => r.year === y && r.month === m);
		return row ? parseFloat(row.total) : 0;
	};

	const data = months.map((month, index) => ({
		month,
		currentYear: findTotal(monthlyRevenue, currentYear, index + 1),
		previousYear: findTotal(monthlyRevenue, previousYear, index + 1),
		forecast: findTotal(monthlyForecast, currentYear, index + 1),
	}));

	const total = data.reduce((sum, d) => sum + d.currentYear, 0);

	return {
		data,
		total,
		year: currentYear,
	};
};

// ============================================================================
// REVENUE BY JOB TYPE
// ============================================================================

export const getRevenueByJobType = async (
	startDate: string,
	endDate: string,
	organizationId: string,
) => {
	const start = reportInstant(startDate);
	const end = reportInstant(endDate);

	const sdb = getScopedDb(organizationId);

	const baseWhere = {
		status: "Completed" as const,
		actual_end_at: { gte: start, lte: end },
		job: { organization_id: organizationId },
	};

	const [oneTimeResult, recurringResult] = await Promise.all([
		sdb.job_visit.aggregate({
			_sum: { total: true },
			where: {
				...baseWhere,
				job: { organization_id: organizationId, recurring_plan_id: null },
			},
		}),
		sdb.job_visit.aggregate({
			_sum: { total: true },
			where: {
				...baseWhere,
				job: { organization_id: organizationId, recurring_plan_id: { not: null } },
			},
		}),
	]);

	const oneTimeRevenue = Number(oneTimeResult._sum?.total ?? 0);
	const recurringRevenue = Number(recurringResult._sum?.total ?? 0);

	return {
		data: [
			{ type: "One-Time", revenue: oneTimeRevenue },
			{ type: "Recurring", revenue: recurringRevenue },
		],
		total: oneTimeRevenue + recurringRevenue,
	};
};

// ============================================================================
// LEADS BY SOURCE
// ============================================================================

export const getLeadsBySource = async (
	startDate: string,
	endDate: string,
	organizationId: string,
) => {
	const start = parseReportDate(startDate, "start");
	const end = parseReportDate(endDate, "end");
	const sdb = getScopedDb(organizationId);

	// Count of requests/leads grouped by the source
	const rows = await sdb.$queryRaw<{ source: string; count: number }[]>`
		SELECT
			LOWER(TRIM(source)) AS source,
			COUNT(*)::int AS count
		FROM request
		WHERE organization_id = ${organizationId}
			AND created_at >= ${start}
			AND created_at <= ${end}
			AND source IS NOT NULL
			AND TRIM(source) <> ''
		GROUP BY LOWER(TRIM(source))
		ORDER BY count DESC
	`;

	const toTitleCase = (s: string) =>
		s
			.split(/\s+/)
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(" ");

	let total = 0;
	const data = rows.map((row) => {
		total += row.count;
		return { source: toTitleCase(row.source), count: row.count };
	});

	return { data, total };
};

// ============================================================================
// UNSCHEDULED REVENUE
// ============================================================================

export const getUnscheduledRevenue = async (organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const results = await sdb.$queryRaw<{ bucket: string, count: number, revenue: string }[]>`
		SELECT
			CASE
				WHEN EXTRACT(DAY FROM (NOW() - created_at)) > 30 THEN 'critical'
				WHEN EXTRACT(DAY FROM (NOW() - created_at)) >= 7 THEN 'warning'
				ELSE 'new'
			END AS bucket,
			COUNT(*)::int AS count,
			COALESCE(SUM(estimated_total), 0)::text AS revenue
		FROM job
		WHERE status = 'Unscheduled'
			AND organization_id = ${organizationId}
		GROUP BY bucket
	`;

	const buckets = {
		new: { revenue: 0, count: 0 },
		warning: { revenue: 0, count: 0 },
		critical: { revenue: 0, count: 0 },
	};

	let totalRevenue = 0;
	let jobCount = 0;

	for (const row of results) {
		const rev = Number(row.revenue);
		const count = row.count;
		const b = row.bucket as keyof typeof buckets;

		buckets[b].revenue = Math.round(rev * 100) / 100;
		buckets[b].count = count;

		totalRevenue += rev;
		jobCount += count;
	}

	return {
		totalRevenue: Math.round(totalRevenue * 100) / 100,
		jobCount,
		new: buckets.new,
		warning: buckets.warning,
		critical: buckets.critical,
	};
};

// ============================================================================
// WORK ORDER STATUS BACKLOG
// ============================================================================

const BACKLOG_STATUSES = ["Unscheduled", "Scheduled", "InProgress"] as const;
type BacklogStatus = (typeof BACKLOG_STATUSES)[number];
type BacklogBucketKey = "fresh" | "aging" | "stalled";

export type BacklogQueryRow = {
	status: BacklogStatus,
	bucket: BacklogBucketKey,
	count: number,
	revenue: string,
};

//Resets when a status is changed to track the job sitting idle
// at that status
export const getJobBacklog = async (organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const results = await sdb.$queryRaw<BacklogQueryRow[]>`
		SELECT
			status,
			CASE
				WHEN age_anchor < NOW() - INTERVAL '30 days' THEN 'stalled'
				WHEN age_anchor < NOW() - INTERVAL '7 days'  THEN 'aging'
				ELSE 'fresh'
			END AS bucket,
			COUNT(*)::int AS count,
			COALESCE(SUM(estimated_total), 0)::text AS revenue
		FROM (
			SELECT status, estimated_total,
				CASE
					WHEN status = 'Unscheduled' THEN created_at
					ELSE status_changed_at
				END AS age_anchor
			FROM job
			WHERE status IN ('Unscheduled', 'Scheduled', 'InProgress')
				AND organization_id = ${organizationId}
				-- Recurring-plan container jobs are created InProgress and stay there for
				-- the life of the plan; they are not work waiting to be scheduled.
				AND recurring_plan_id IS NULL
		) t
		GROUP BY status, bucket
	`;

	return aggregateBacklog(results);
};

export const aggregateBacklog = (results: BacklogQueryRow[]) => {
	const emptyBucket = () => ({ count: 0, revenue: 0 });
	const emptyRow = () => ({
		fresh: emptyBucket(),
		aging: emptyBucket(),
		stalled: emptyBucket(),
		total: emptyBucket(),
	});

	const byStatus: Record<BacklogStatus, ReturnType<typeof emptyRow>> = {
		Unscheduled: emptyRow(),
		Scheduled: emptyRow(),
		InProgress: emptyRow(),
	};
	const totals = emptyRow();

	for (const r of results) {
		const row = byStatus[r.status];
		if (!row) continue;
		const revenue = round2(Number(r.revenue));

		row[r.bucket].count += r.count;
		row[r.bucket].revenue = round2(row[r.bucket].revenue + revenue);
		row.total.count += r.count;
		row.total.revenue = round2(row.total.revenue + revenue);

		totals[r.bucket].count += r.count;
		totals[r.bucket].revenue = round2(totals[r.bucket].revenue + revenue);
		totals.total.count += r.count;
		totals.total.revenue = round2(totals.total.revenue + revenue);
	}

	return {
		statuses: BACKLOG_STATUSES.map((status) => ({ status, ...byStatus[status] })),
		totals,
	};
};

// ============================================================================
// ARRIVAL PERFORMANCE
// ============================================================================

const ARRIVAL_EARLY_SECONDS = -900;
const ARRIVAL_LATE_SECONDS = 1800;

export const classifyArrival = (
	scheduledStartAt: Date,
	actualStartAt: Date | null,
): "Early" | "On Time" | "Late" | null => {
	if (!actualStartAt) return null;
	const deltaSeconds = (actualStartAt.getTime() - scheduledStartAt.getTime()) / 1000;
	if (deltaSeconds < ARRIVAL_EARLY_SECONDS) return "Early";
	if (deltaSeconds > ARRIVAL_LATE_SECONDS) return "Late";
	return "On Time";
};

export const getArrivalPerformance = async (
	startDate: string,
	endDate: string,
	organizationId: string,
) => {
	const start = parseReportDate(startDate, "start");
	const end = parseReportDate(endDate, "end");

	const sdb = getScopedDb(organizationId);
	const result = await sdb.$queryRaw<[{ early: number, on_time: number, late: number }]>`
		SELECT
			COUNT(CASE WHEN EXTRACT(EPOCH FROM (actual_start_at - scheduled_start_at)) < ${ARRIVAL_EARLY_SECONDS} THEN 1 END)::int AS early,
			COUNT(CASE WHEN EXTRACT(EPOCH FROM (actual_start_at - scheduled_start_at)) > ${ARRIVAL_LATE_SECONDS} THEN 1 END)::int AS late,
			COUNT(CASE WHEN EXTRACT(EPOCH FROM (actual_start_at - scheduled_start_at)) BETWEEN ${ARRIVAL_EARLY_SECONDS} AND ${ARRIVAL_LATE_SECONDS} THEN 1 END)::int AS on_time
		FROM job_visit jv
		JOIN job j ON j.id = jv.job_id
		WHERE jv.actual_start_at IS NOT NULL
			AND jv.actual_start_at >= ${start}
			AND jv.actual_start_at <= ${end}
			AND j.organization_id = ${organizationId}
	`;

	const stats = result[0] || { early: 0, on_time: 0, late: 0 };
	const total = stats.early + stats.on_time + stats.late;
	const onTimeRate = total > 0 ? Math.round(((stats.early + stats.on_time) / total) * 100) : 0;

	return {
		early: stats.early,
		onTime: stats.on_time,
		late: stats.late,
		total,
		onTimeRate,
	};
};

// ============================================================================
// QUOTE PIPELINE
// ============================================================================

// A quote still awaiting a decision — not yet Approved, Revised, or one of
// LOST_QUOTE_STATUSES. Was declared locally in two places with the same
// literal (DW-71); one source of truth so the pipeline stat and the page
// summary's quote widget can't drift apart on what "open" means.
const QUOTE_OPEN_STATUSES = ["Draft", "Sent", "Viewed", "Disputed"] as const;

export const getQuotePipeline = async (startDate: string, endDate: string, organizationId: string) => {
	const start = parseReportDate(startDate, "start");
	const end = parseReportDate(endDate, "end");

	const sdb = getScopedDb(organizationId);
	const grouped = await sdb.quote.groupBy({
		by: ["status"],
		where: {
			organization_id: organizationId,
			status: { in: [...QUOTE_OPEN_STATUSES] },
			created_at: { gte: start, lte: end },
		},
		_sum: { total: true },
		_count: { _all: true },
	});

	const buckets = {
		Draft: { revenue: 0, count: 0 },
		Sent: { revenue: 0, count: 0 },
		Viewed: { revenue: 0, count: 0 },
		Disputed: { revenue: 0, count: 0 },
	};

	let totalRevenue = 0;
	let quoteCount = 0;

	for (const group of grouped) {
		const revenue = Number(group._sum?.total ?? 0);
		const count = group._count?._all ?? 0;

		buckets[group.status as keyof typeof buckets] = {
			revenue: Math.round(revenue * 100) / 100,
			count,
		};

		totalRevenue += revenue;
		quoteCount += count;
	}

	return {
		totalRevenue: Math.round(totalRevenue * 100) / 100,
		quoteCount,
		draft: buckets.Draft,
		sent: buckets.Sent,
		viewed: buckets.Viewed,
		disputed: buckets.Disputed,
	};
};

// ============================================================================
// MILEAGE REPORT
// ============================================================================

export interface MileageReportVisitRow {
	visitId: string;
	jobId: string;
	jobName: string;
	jobAddress: string;
	clientName: string;
	visitDate: string; 
	miles: number;
	visitStatus: string;
	technicianNames: string; // multiple techs can be on one job visit
}

export const getMileageReport = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
): Promise<MileageReportVisitRow[]> => {
	const sdb = getScopedDb(organizationId);

	const dateFilter = buildDateFilter(startDate, endDate);

	const visits = await sdb.job_visit.findMany({
		where: {
			OR: [{ estimated_drive_miles: { not: null } }, { estimated_return_drive_miles: { not: null } }],
			job: { organization_id: organizationId },
			...(Object.keys(dateFilter).length && { scheduled_start_at: dateFilter }),
		},
		include: {
			job: {
				select: {
					id: true,
					name: true,
					address: true,
					client: { select: { name: true } },
				},
			},
			visit_techs: {
				include: { tech: { select: { id: true, name: true } } },
			},
		},
		orderBy: { scheduled_start_at: "desc" },
	});

	return visits.map((v) => ({
		visitId: v.id,
		jobId: v.job.id,
		jobName: v.job.name,
		jobAddress: v.job.address,
		clientName: v.job.client?.name ?? "Unknown Client",
		visitDate: v.scheduled_start_at.toISOString(),
		miles: Number(v.estimated_drive_miles ?? 0) + Number(v.estimated_return_drive_miles ?? 0),
		visitStatus: v.status,
		technicianNames: v.visit_techs.map((vt) => vt.tech.name).join(", ") || "Unassigned",
	}));
};

// ============================================================================
// TIMESHEETS REPORT
// ============================================================================

export interface TimesheetReportRow {
	shiftId: string;
	technicianId: string;
	technicianName: string;
	startedAt: string;
	endedAt: string;
	grossHours: number;
	breakHours: number;
	payableHours: number;
	visitHours: number;
	driveHours: number;
	visitCount: number;
}

type TimeSpan = { start: Date; end: Date };
type VisitSpan = TimeSpan & { visitId: string };

export function shiftSplitHours(
	shift: TimeSpan,
	entries: TimeSpan[],
	drives: TimeSpan[],
	breaks: (TimeSpan & { paid: boolean })[],
) {
	const tag = <T extends TimeSpan>(s: T) => ({ ...s, label: "", sub: "" });
	const segments = buildShiftSegments(shift, entries.map(tag), drives.map(tag), breaks.map(tag));
	const hoursOf = (type: string) =>
		segments
			.filter((s) => s.type === type)
			.reduce((h, s) => h + (s.end.getTime() - s.start.getTime()) / 3_600_000, 0);
	return { visitHours: hoursOf("job"), driveHours: hoursOf("drive") };
}

export const getTimesheetReport = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
): Promise<TimesheetReportRow[]> => {
	const sdb = getScopedDb(organizationId);

	const dateFilter = buildDateFilter(startDate, endDate);

	const shifts = await sdb.technician_shift.findMany({
		where: {
			org_id: organizationId,
			ended_at: { not: null },
			payable_hours: { not: null },
			...(Object.keys(dateFilter).length && { started_at: dateFilter }),
		},
		include: {
			tech: { select: { id: true, name: true } },
			breaks: { select: { started_at: true, ended_at: true, is_paid: true } },
		},
		orderBy: { started_at: "desc" },
	});

	const entriesByTech = new Map<string, VisitSpan[]>();
	const drivesByTech = new Map<string, TimeSpan[]>();
	const addSpan = <T extends TimeSpan>(map: Map<string, T[]>, techId: string, span: T) =>
		map.set(techId, [...(map.get(techId) ?? []), span]);
	if (shifts.length) {
		const techIds = [...new Set(shifts.map((s) => s.tech_id))];
		const from = shifts[shifts.length - 1].started_at;
		const to = new Date(Math.max(...shifts.map((s) => s.ended_at!.getTime())));
		const [entries, drives] = await Promise.all([
			sdb.visit_tech_time_entry.findMany({
				where: {
					tech_id: { in: techIds },
					clocked_out_at: { not: null, gt: from },
					clocked_in_at: { lt: to },
				},
				select: { tech_id: true, visit_id: true, clocked_in_at: true, clocked_out_at: true },
			}),
			sdb.visit_tech_drive.findMany({
				where: {
					tech_id: { in: techIds },
					ended_at: { not: null, gt: from },
					started_at: { lt: to },
				},
				select: { tech_id: true, started_at: true, ended_at: true },
			}),
		]);
		for (const e of entries)
			addSpan(entriesByTech, e.tech_id, { start: e.clocked_in_at, end: e.clocked_out_at!, visitId: e.visit_id });
		for (const d of drives) addSpan(drivesByTech, d.tech_id, { start: d.started_at, end: d.ended_at! });
	}

	return shifts.map((s) => {
		const entries = entriesByTech.get(s.tech_id) ?? [];
		return {
			shiftId: s.id,
			technicianId: s.tech.id,
			technicianName: s.tech.name,
			startedAt: s.started_at.toISOString(),
			endedAt: s.ended_at!.toISOString(),
			grossHours: Number(s.gross_hours ?? 0),
			breakHours: Number(s.break_hours ?? 0),
			payableHours: Number(s.payable_hours),
			...shiftSplitHours(
				{ start: s.started_at, end: s.ended_at! },
				entries,
				drivesByTech.get(s.tech_id) ?? [],
				s.breaks.map((b) => ({ start: b.started_at, end: b.ended_at ?? s.ended_at!, paid: b.is_paid })),
			),
			visitCount: new Set(
				entries.filter((e) => e.start < s.ended_at! && e.end > s.started_at).map((e) => e.visitId),
			).size,
		};
	});
};

// ============================================================================
// INVENTORY REORDER FORECAST
// ============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

type ReorderForecastRow = {
	itemId: string;
	itemName: string;
	sku: string | null;
	category: string | null;
	unit: string;
	// Org-wide, to match the consumption denominator below; split kept since "buy more" vs "move to a van" are different actions.
	currentQuantity: number;
	warehouseQuantity: number;
	vehicleQuantity: number;
	// null on a unit break (see consumptionBasis) — unlike the cached on-hand figures above, these are summed from the ledger.
	qtyConsumed: number | null;
	avgDailyUsage: number | null;
	// Derived from stamped movement units, not `unit` above (that's the item's CURRENT unit — wrong source). When mixed, rate/runway/stockout are withheld.
	consumptionBasis: UnitBasis;
	// Actual history available, capped at the lookback window — the rate divides by this, not the window.
	observedDays: number;
	daysOfStock: number | null;
	projectedStockoutDate: string | null;
	lowStockThreshold: number | null;
	// Warehouse-scoped, like getStockStatus and the low-stock alert emails — the runway above is org-wide.
	belowReorderPoint: boolean;
	// Computed once here so every surface (table, chart, detail page, export) agrees. Band geometry stays frontend.
	severity: ReorderSeverity;
	// Who to buy it from. Null throughout when the item has no vendor on file —
	// the forecast still says what to buy, it just can't say where.
	preferredSupplierId: string | null;
	preferredSupplierName: string | null;
	// The vendor's part number, which is what you actually order by.
	vendorSku: string | null;
	preferredUnitPrice: number | null;
	// Which figure the price came from. Stated because a negotiated rate and a
	// one-off counter price deserve different confidence.
	priceSource: "contract" | "observed" | "none";
	// Whether someone CHOSE this vendor or we fell back to whoever sold it last.
	// Without this the table would present a guess as a decision.
	vendorSource: "preferred" | "recent" | "none";
	// Units needed to get back to the reorder point — the existing warehouse-scoped
	// threshold, not an invented order policy. Null when no threshold is set.
	shortfallQty: number | null;
	estimatedShortfallCost: number | null;
};

export type ReorderSeverity = "critical" | "warning" | "healthy" | "unknown";

const REORDER_SEVERITY_RANK: Record<ReorderSeverity, number> = {
	critical: 0,
	warning: 1,
	healthy: 2,
	unknown: 3,
};

// Constants live here, not the UI, so they can become per-org settings later.
const REORDER_CRITICAL_DAYS = 7;
const REORDER_WARNING_DAYS = 21;
const REORDER_NEAR_THRESHOLD_FACTOR = 1.25;

// Divides by the OBSERVED span, not the requested window — a 10-day-old item
// dividing its burn by a 90-day window would understate the rate 9x.
// `evidenceAgeDays` is the age of the oldest evidence (item creation or first
// consumption in window, whichever is earlier), since movements can predate the row.
export const usageRate = (input: {
	qtyConsumed: number;
	lookbackDays: number;
	evidenceAgeDays: number;
}): { avgDailyUsage: number; observedDays: number } => {
	const observedDays = Math.max(1, Math.min(input.lookbackDays, input.evidenceAgeDays));
	// Reversal netting can drive this negative if the reversal lands inside the window but the movement it undoes doesn't — clamp to 0 rather than report negative demand.
	const qtyConsumed = Math.max(0, input.qtyConsumed);
	return { avgDailyUsage: qtyConsumed / observedDays, observedDays };
};

export const reorderSeverity = (input: {
	belowReorderPoint: boolean;
	daysOfStock: number | null;
	lowStockThreshold: number | null;
	warehouseQuantity: number;
}): ReorderSeverity => {
	if (input.belowReorderPoint) return "critical";
	if (input.daysOfStock != null) {
		if (input.daysOfStock <= REORDER_CRITICAL_DAYS) return "critical";
		if (input.daysOfStock <= REORDER_WARNING_DAYS) return "warning";
		return "healthy";
	}
	if (
		input.lowStockThreshold != null &&
		input.warehouseQuantity <= input.lowStockThreshold * REORDER_NEAR_THRESHOLD_FACTOR
	) {
		return "warning";
	}
	return "unknown";
};

// Shared by the fleet-wide reorder report and the single-item forecast (itemId
// filters to one row) so the two surfaces can't disagree about the same item.
// Permission-agnostic — callers gate access before calling it.
//
// "Days of stock" = org-wide on-hand (warehouse + vehicles) / org-wide daily
// consumption. Warehouse<->vehicle transfers are not demand; `loss` is excluded
// from the rate even though it does drain stock.
/**
 * Names a vendor and a price on every forecast row that has one.
 *
 * The forecast has always been able to say WHAT to buy and WHEN, then stopped
 * there. One query for the whole page (not one per row) attaches the rest.
 *
 * Vendor choice: an explicitly preferred row wins; otherwise the most recent
 * purchase stands in, flagged as such — falling back is more useful than a blank
 * column, but presenting the fallback as a decision would be a lie.
 *
 * Price choice: a negotiated `contract_price` beats an observed `last_price`,
 * because one is what you WILL pay and the other is what you happened to pay.
 */
const attachPreferredVendors = async (
	organizationId: string,
	rows: ReorderForecastRow[],
): Promise<void> => {
	if (rows.length === 0) return;
	const sdb = getScopedDb(organizationId);

	const vendorRows = await sdb.supplier_item.findMany({
		where: {
			organization_id: organizationId,
			inventory_item_id: { in: rows.map((r) => r.itemId) },
			// A retired vendor must not be the answer to "who do I buy this from".
			supplier: { is_active: true },
		},
		select: {
			inventory_item_id: true,
			supplier_id: true,
			vendor_sku: true,
			contract_price: true,
			last_price: true,
			last_purchased_at: true,
			is_preferred: true,
			supplier: { select: { name: true } },
		},
		// Preferred first, then most recently purchased — so the first row seen
		// per item is the one to use and later rows can be skipped. Postgres
		// defaults NULLS FIRST on a desc sort, which would rank a contract-only
		// row (never actually purchased, last_purchased_at: null) ahead of a row
		// with a real recent purchase date — the opposite of "most recent" wins.
		orderBy: [{ is_preferred: "desc" }, { last_purchased_at: { sort: "desc", nulls: "last" } }],
	});

	const chosen = new Map<string, (typeof vendorRows)[number]>();
	for (const v of vendorRows) {
		if (!chosen.has(v.inventory_item_id)) chosen.set(v.inventory_item_id, v);
	}

	for (const row of rows) {
		const v = chosen.get(row.itemId);
		if (!v) continue;

		const { price, priceSource } = resolveVendorPrice(v.contract_price, v.last_price);

		row.preferredSupplierId = v.supplier_id;
		row.preferredSupplierName = v.supplier.name;
		row.vendorSku = v.vendor_sku;
		row.preferredUnitPrice = price;
		row.priceSource = priceSource;
		row.vendorSource = v.is_preferred ? "preferred" : "recent";
		row.estimatedShortfallCost =
			price != null && row.shortfallQty != null ? price * row.shortfallQty : null;
	}
};

const buildReorderForecast = async (
	organizationId: string,
	opts: { lookbackDays: number; itemId?: string },
): Promise<ReorderForecastRow[]> => {
	const { lookbackDays, itemId } = opts;
	const sdb = getScopedDb(organizationId);
	const cutoff = new Date(Date.now() - lookbackDays * DAY_MS);
	const itemFilter = itemId ? Prisma.sql`AND ii.id = ${itemId}` : Prisma.empty;

	const rows = await sdb.$queryRaw<
		{
			itemId: string;
			itemName: string;
			sku: string | null;
			category: string | null;
			unit: string;
			warehouseQty: number;
			vehicleQty: number;
			qtyConsumed: number | null;
			consumedUnits: string[] | null;
			lowStockThreshold: number | null;
			createdAt: Date;
			firstConsumedAt: Date | null;
		}[]
	>`
		SELECT * FROM (
			SELECT
				ii.id AS "itemId",
				ii.name AS "itemName",
				ii.sku AS "sku",
				ii.category AS "category",
				ii.unit AS "unit",
				ii.quantity::float AS "warehouseQty",
				-- Cast every numeric here; otherwise the driver hands back a Decimal,
				-- not a number, and callers relying on the row type die on .toFixed().
				ii.low_stock_threshold::float AS "lowStockThreshold",
				ii.created_at AS "createdAt",
				-- Oldest consumption evidence in window; paired with created_at
				-- (see usageRate) since movements can predate the item row.
				(
					SELECT MIN(sm.created_at)
					FROM stock_movement sm
					WHERE sm.inventory_item_id = ii.id
						AND sm.organization_id = ${organizationId}
						AND sm.created_at >= ${cutoff}
						-- Evidence only, so no reversals: this is not the shared predicate.
						AND (
							sm.reason IN ('parts_used', 'direct_consumption')
							OR (sm.reason = 'supplier_purchase' AND sm.to_location_type = 'consumed')
						)
				)                                   AS "firstConsumedAt",
				-- vehicle_stock_item has no org column of its own; scope through vehicle.
				COALESCE((
					SELECT SUM(vsi.qty_on_hand)
					FROM vehicle_stock_item vsi
					JOIN vehicle v ON v.id = vsi.vehicle_id
					WHERE vsi.inventory_item_id = ii.id
						AND v.organization_id = ${organizationId}
				), 0)::float                        AS "vehicleQty",
				-- Net of reversals (lib/inventory.ts CONSUMPTION_*), same as the item page.
				COALESCE((
					SELECT SUM(${CONSUMPTION_SIGNED_QTY})
					FROM stock_movement sm
					WHERE sm.inventory_item_id = ii.id
						AND sm.organization_id = ${organizationId}
						AND sm.created_at >= ${cutoff}
						AND ${CONSUMPTION_MOVEMENT_PREDICATE}
				), 0)::float                        AS "qtyConsumed",
				-- Stamped units behind that sum (same reason set + window) — the
				-- item's own unit column says nothing about what the ledger used.
				(
					SELECT array_agg(DISTINCT sm.unit)
					FROM stock_movement sm
					WHERE sm.inventory_item_id = ii.id
						AND sm.organization_id = ${organizationId}
						AND sm.created_at >= ${cutoff}
						AND ${CONSUMPTION_MOVEMENT_PREDICATE}
				)                                   AS "consumedUnits"
			FROM inventory_item ii
			WHERE ii.organization_id = ${organizationId}
				AND ii.is_active = true
				${itemFilter}
		) f
		-- Ordering happens in SQL so the LIMIT truncates the least urgent rows, not
		-- an arbitrary set. qty/consumed is a runway proxy (raw sum, mixed units and
		-- all) good enough to rank by — the real per-row rate is computed below, and
		-- the raw number never reaches the response.
		ORDER BY
			(f."lowStockThreshold" IS NOT NULL AND f."warehouseQty" < f."lowStockThreshold") DESC,
			CASE
				WHEN f."qtyConsumed" > 0
					THEN (f."warehouseQty" + f."vehicleQty") / f."qtyConsumed"
				ELSE 1e9
			END ASC,
			f."itemId" ASC
		LIMIT ${REPORT_ROW_CAP}
	`;

	const now = Date.now();

	const built = rows.map((r) => {
		const warehouseQuantity = r.warehouseQty;
		const vehicleQuantity = r.vehicleQty;
		const currentQuantity = warehouseQuantity + vehicleQuantity;
		const rawConsumed = Math.max(0, Number(r.qtyConsumed ?? 0));

		// Whichever came first, item creation or first consumption in window; usageRate caps this at the window itself.
		const evidenceStart = Math.min(
			new Date(r.createdAt).getTime(),
			r.firstConsumedAt ? new Date(r.firstConsumedAt).getTime() : Infinity,
		);
		// observedDays is computed even when the quantity is unusable (unit break) — only the quantity-derived half gets withheld below.
		const { avgDailyUsage: rawRate, observedDays } = usageRate({
			qtyConsumed: rawConsumed,
			lookbackDays,
			evidenceAgeDays: (now - evidenceStart) / DAY_MS,
		});

		// Unit break (e.g. `12 each + 3 box`) makes the numerator unusable — qty, rate, and runway are withheld together so the card can't show a rate with no runway.
		const consumptionBasis = unitBasis(r.consumedUnits);
		const qtyConsumed = consumptionBasis.mixed ? null : rawConsumed;
		const avgDailyUsage = consumptionBasis.mixed ? null : rawRate;
		const daysOfStock =
			avgDailyUsage != null && avgDailyUsage > 0 ? currentQuantity / avgDailyUsage : null;
		const projectedStockoutDate =
			daysOfStock === null ? null : new Date(now + daysOfStock * DAY_MS).toISOString();

		const lowStockThreshold = r.lowStockThreshold ?? null;
		// `<`, not `<=`, to agree with lib/inventory.getStockStatus — otherwise this report and the inventory list disagree at exactly the threshold.
		const belowReorderPoint =
			lowStockThreshold != null && warehouseQuantity < lowStockThreshold;

		return {
			itemId: r.itemId,
			itemName: r.itemName,
			sku: r.sku ?? null,
			category: r.category ?? null,
			unit: r.unit,
			currentQuantity,
			warehouseQuantity,
			vehicleQuantity,
			qtyConsumed,
			avgDailyUsage,
			consumptionBasis,
			observedDays,
			daysOfStock,
			projectedStockoutDate,
			lowStockThreshold,
			belowReorderPoint,
			severity: reorderSeverity({
				belowReorderPoint,
				daysOfStock,
				lowStockThreshold,
				warehouseQuantity,
			}),
			// Filled in below, once the vendor rows for the whole page are read
			// in one query instead of one per item.
			preferredSupplierId: null,
			preferredSupplierName: null,
			vendorSku: null,
			preferredUnitPrice: null,
			priceSource: "none" as const,
			vendorSource: "none" as const,
			shortfallQty:
				lowStockThreshold == null
					? null
					: Math.max(0, lowStockThreshold - warehouseQuantity),
			estimatedShortfallCost: null,
		};
	});

	await attachPreferredVendors(organizationId, built);

	// Severity first, then runway. Sorting on projectedStockoutDate alone mapped
	// null to Infinity, burying rows with no measured usage below every healthy
	// item. AdaptableTable has no column sorting, so this default order is the
	// only order — it must agree with the severity the report renders.
	built.sort((a, b) => {
		const sev = REORDER_SEVERITY_RANK[a.severity] - REORDER_SEVERITY_RANK[b.severity];
		if (sev !== 0) return sev;
		// Within a band, shortest runway first; no-runway rows sort to the end of
		// their own band rather than the end of the report.
		const aD = a.daysOfStock ?? Infinity;
		const bD = b.daysOfStock ?? Infinity;
		if (aD !== bD) return aD - bD;
		return a.itemName.localeCompare(b.itemName);
	});

	return built;
};

const INVENTORY_INCLUDE = {
	tags: { orderBy: { label: "asc" } },
	vehicle_stocks: { select: { qty_on_hand: true, qty_standard: true } },
} satisfies Prisma.inventory_itemInclude;

const inventoryBaseWhere = (includeInactive: boolean): Record<string, unknown> => ({
	provisional: false,
	...(includeInactive ? {} : { is_active: true }),
});

// Grouped by (item, unit), not item alone — the extra key is what surfaces a
// unit break: >1 group per item means its consumption can't be totalled.
// `itemIds` scopes the group-by to a hydrated page's rows.
//
// Net of reversals (from_location_type = 'consumed' cancels demand that never
// happened) — the same netting buildReorderForecast applies, so the inventory
// report and the forecast agree on what was consumed. `reason` is in the group
// key only so the reversal rows can be subtracted; it is folded away below.
// This is a Prisma groupBy, so it uses the object form of the predicate; the raw-SQL
// reports use CONSUMPTION_MOVEMENT_PREDICATE / CONSUMPTION_SIGNED_QTY from lib/inventory.ts.
// Keep the two in lockstep.
const inventoryUsageByItem = async (
	sdb: ReturnType<typeof getScopedDb>,
	organizationId: string,
	from?: Date,
	to?: Date,
	itemIds?: string[],
): Promise<Map<string, { qty: number; units: string[] }>> => {
	const usage = await sdb.stock_movement.groupBy({
		by: ["inventory_item_id", "unit", "reason"],
		where: {
			organization_id: organizationId,
			OR: [
				{ reason: { in: ["parts_used", "direct_consumption"] } },
				{ reason: "reversal", from_location_type: "consumed" },
				{ reason: "supplier_purchase", to_location_type: "consumed" },
			],
			...(from && to ? { created_at: { gte: from, lte: to } } : {}),
			...(itemIds ? { inventory_item_id: { in: itemIds } } : {}),
		},
		_sum: { qty: true },
	});
	const byItem = new Map<string, { qty: number; units: string[] }>();
	for (const u of usage) {
		const entry = byItem.get(u.inventory_item_id) ?? { qty: 0, units: [] };
		const qty = Number(u._sum.qty ?? 0);
		entry.qty += u.reason === "reversal" ? -qty : qty;
		if (!entry.units.includes(u.unit)) entry.units.push(u.unit);
		byItem.set(u.inventory_item_id, entry);
	}
	return byItem;
};

const mapInventoryItem = (
	item: Prisma.inventory_itemGetPayload<{ include: typeof INVENTORY_INCLUDE }>,
	usageByItem: Map<string, { qty: number; units: string[] }>,
) => {
	const used = usageByItem.get(item.id);
	const qtyUsedBasis: UnitBasis = unitBasis(used?.units);
	const fleetQty = item.vehicle_stocks.reduce((sum, vs) => sum + Number(vs.qty_on_hand ?? 0), 0);
	const fleetStandard = item.vehicle_stocks.reduce(
		(sum, vs) => sum + Number(vs.qty_standard ?? 0),
		0,
	);
	// Coerced: numeric(10,2) arrives as a Decimal, and `+` against a number concatenates strings instead of adding ("9" + 5 = "95").
	const warehouseQty = Number(item.quantity);
	const totalQty = warehouseQty + fleetQty;
	const cost = item.cost != null ? Number(item.cost) : null;

	return {
		id: item.id,
		name: item.name,
		sku: item.sku ?? null,
		category: item.category ?? null,
		description: item.description,
		unit: item.unit,
		isActive: item.is_active,
		quantity: warehouseQty,
		fleetQty,
		fleetStandard,
		totalQty,
		// Same Decimal-coercion reason as warehouseQty above.
		lowStockThreshold:
			item.low_stock_threshold == null ? null : Number(item.low_stock_threshold),
		cost,
		unitPrice: item.unit_price != null ? Number(item.unit_price) : null,
		assetValue: cost != null ? cost * totalQty : null,
		// null, not 0, on a unit break — 0 is a real answer ("never consumed") and shouldn't be confused with "cannot be totalled".
		qtyUsed: qtyUsedBasis.mixed ? null : (used?.qty ?? 0),
		qtyUsedBasis,
		stockStatus: getStockStatus(warehouseQty, item.low_stock_threshold),
		location: item.location,
		tags: item.tags,
		altIds: item.alt_ids,
		updatedAt: item.updated_at,
	};
};

// `truncated` is surfaced, not just logged, so the report can say so on screen instead of silently passing off a short list as complete.
export const getInventoryReorderForecast = async (
	organizationId: string,
	opts: { lookbackDays: number },
): Promise<{ rows: ReorderForecastRow[]; truncated: boolean }> => {
	const rows = await buildReorderForecast(organizationId, opts);
	return { rows, truncated: rows.length >= REPORT_ROW_CAP };
};

// Single-item variant, scoped via buildReorderForecast's itemId filter. Returns
// null if filtered out (e.g. inactive) — the caller in
// inventoryController.getItemForecast treats that as "no forecast", not a 404.
export const getItemReorderForecast = async (
	organizationId: string,
	itemId: string,
	opts: { lookbackDays: number },
): Promise<ReorderForecastRow | null> => {
	const rows = await buildReorderForecast(organizationId, { ...opts, itemId });
	return rows[0] ?? null;
};

export const getInventoryReport = async (
	organizationId: string,
	opts: { from?: Date; to?: Date; includeInactive: boolean },
) => {
	const { from, to, includeInactive } = opts;
	const sdb = getScopedDb(organizationId);

	const items = await sdb.inventory_item.findMany({
		where: inventoryBaseWhere(includeInactive),
		orderBy: { name: "asc" },
		include: INVENTORY_INCLUDE,
	});
	const usageByItem = await inventoryUsageByItem(sdb, organizationId, from, to);
	return items.map((item) => mapInventoryItem(item, usageByItem));
};

const FLEET_ON_HAND =
	'(SELECT COALESCE(SUM(vs.qty_on_hand), 0) FROM "vehicle_stock_item" vs WHERE vs.inventory_item_id = ii.id)';

export const INVENTORY_SQL_COLUMNS: ColumnMap = {
	itemName: t("ii.name"),
	sku: t("ii.sku"),
	category: t("ii.category"),
	description: t("ii.description"),
	unit: t("ii.unit"),
	location: t("ii.location"),
	status: t("CASE WHEN ii.is_active THEN 'Active' ELSE 'Discontinued' END"),
	quantity: n("ii.quantity"),
	lowStockThreshold: n("ii.low_stock_threshold"),
	cost: cur("ii.cost"),
	unitPrice: cur("ii.unit_price"),
	fleetQty: n(FLEET_ON_HAND),
	fleetStandard: n(
		'(SELECT COALESCE(SUM(vs.qty_standard), 0) FROM "vehicle_stock_item" vs WHERE vs.inventory_item_id = ii.id)',
	),
	totalQty: n(`(ii.quantity + ${FLEET_ON_HAND})`),
	assetValue: cur(`(ii.cost * (ii.quantity + ${FLEET_ON_HAND}))`),
	updatedAt: dt("ii.updated_at"),
};

export const getInventoryReportPage = async (
	organizationId: string,
	opts: { from?: Date; to?: Date; includeInactive: boolean },
	params: PaginateParams,
) => {
	const { from, to, includeInactive } = opts;
	const sdb = getScopedDb(organizationId);
	const baseParams: unknown[] = [organizationId];
	let baseWhere = "ii.organization_id = $1 AND ii.provisional = false";
	if (!includeInactive) baseWhere += " AND ii.is_active = true";

	const res = await runIdPrefilter({
		sdb,
		from: '"inventory_item" ii',
		baseWhere,
		baseParams,
		idExpr: "ii.id",
		columns: INVENTORY_SQL_COLUMNS,
		defaultOrder: { expr: "ii.name", dir: "asc" },
		params,
		hydrate: (ids) =>
			sdb.inventory_item.findMany({ where: { id: { in: ids } }, include: INVENTORY_INCLUDE }),
		rowId: (r) => r.id,
	});
	if (!res) return null;
	const usageByItem = await inventoryUsageByItem(
		sdb,
		organizationId,
		from,
		to,
		res.rows.map((i) => i.id),
	);
	return {
		rows: res.rows.map((item) => mapInventoryItem(item, usageByItem)),
		total: res.total,
		page: res.page,
		pageSize: res.pageSize,
	};
};

// ============================================================================
// AGED RECEIVABLES
// ============================================================================

// Outstanding invoice balances bucketed by how far past due
//
// Disputed invoices are still owed, so they stay in the receivables total,
// but ageing them alongside uncontested debt misstates collection risk.
// They are reported separately instead.
// The invoice statuses aged receivables leaves out — Draft (not issued yet),
// Paid (settled), Void (cancelled) and Disputed (owed, but reported apart). One
// list feeds the two raw AR queries below and the Prisma-path
// AGING_INVOICE_STATUS, so a new status can't land in one and miss the others.
const AR_EXCLUDED_STATUSES = ["Draft", "Paid", "Void", "Disputed"] as const;
const AR_EXCLUDED_STATUS_SQL = Prisma.raw(
	AR_EXCLUDED_STATUSES.map((s) => `'${s}'`).join(", "),
);

// An invoice row that belongs on aged receivables: a positive balance past its
// terms, or any credit (a negative balance nets now and never ages). `alias` is
// "" for the un-aliased queries and "i." for the joined ones — the only thing
// that differed between the four hand-written copies.
const arCollectableSql = (alias: "" | "i." = "") =>
	Prisma.sql`(
		(${Prisma.raw(`${alias}balance_due`)} > 0 AND COALESCE(${Prisma.raw(`${alias}due_date`)}, ${Prisma.raw(`${alias}created_at`)}) <= NOW())
		OR ${Prisma.raw(`${alias}balance_due`)} < 0
	)`;

export const getAgedReceivables = async (organizationId: string) => {
	const sdb = getScopedDb(organizationId);

	const rows = await sdb.$queryRaw<
		{ bucket: string; count: number; amount: number | null }[]
	>`
		SELECT
			CASE
				-- A credit reduces what is owed NOW, so it never ages: ageing it
				-- would read as the organisation being slow to repay itself,
				-- which is not a collection-risk fact about the client.
				WHEN balance_due < 0 THEN '0-30'
				WHEN COALESCE(due_date, created_at) > NOW() - INTERVAL '31 days' THEN '0-30'
				WHEN COALESCE(due_date, created_at) > NOW() - INTERVAL '61 days' THEN '31-60'
				WHEN COALESCE(due_date, created_at) > NOW() - INTERVAL '91 days' THEN '61-90'
				ELSE '90+'
			END AS bucket,
			COUNT(*)::int          AS count,
			SUM(balance_due)::float AS amount
		FROM invoice
		WHERE organization_id = ${organizationId}
			AND status NOT IN (${AR_EXCLUDED_STATUS_SQL})
			-- <> 0, not > 0: a net-negative adjustment is a credit the client
			-- can spend against this balance, so excluding it overstates
			-- receivables by the whole credit until someone applies it.
			-- Credits skip the due-date gate for the same reason they skip
			-- ageing — terms govern when a charge becomes collectable, not
			-- when a credit becomes real.
			AND ${arCollectableSql()}
		GROUP BY bucket
	`;

	const disputedRows = await sdb.$queryRaw<
		{ amount: number | null; count: number }[]
	>`
		SELECT SUM(balance_due)::float AS amount,
			COUNT(*)::int          AS count
		FROM invoice
		WHERE organization_id = ${organizationId}
			AND status = 'Disputed'
			AND ${arCollectableSql()}
	`;

	const BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;
	const byBucket = new Map(rows.map((r) => [r.bucket, r]));

	const data = BUCKETS.map((bucket) => {
		const row = byBucket.get(bucket);
		return {
			bucket,
			amount: Math.round(Number(row?.amount ?? 0) * 100) / 100,
			count: row?.count ?? 0,
		};
	});

	const disputedTotal = round2(disputedRows[0]?.amount);

	return {
		data,
		disputedTotal,
		// Reported alongside disputedTotal so a caller can reconcile the header
		// count with totalOutstanding, which includes the disputed money.
		disputedCount: disputedRows[0]?.count ?? 0,
		totalOutstanding: data.reduce((sum, d) => sum + d.amount, 0) + disputedTotal,
	};
};

// Outstanding invoice balances bucketed by age and grouped per client
//
// Disputed invoices are still owed, so they stay in the receivables total,
// but ageing them alongside uncontested debt misstates collection risk.
// They are reported separately instead.
export const getAgedReceivablesByClient = async (organizationId: string) => {
	const sdb = getScopedDb(organizationId);

	const rows = await sdb.$queryRaw<
		{
			clientId: string;
			clientName: string;
			bucket0_30: number | null;
			bucket31_60: number | null;
			bucket61_90: number | null;
			bucket90plus: number | null;
			total: number | null;
			count: number;
		}[]
	>`
		SELECT
			c.id   AS "clientId",
			c.name AS "clientName",
			-- Credits never age (see getAgedReceivables): they land in the
			-- current bucket so they net against what is owed now.
			SUM(CASE WHEN i.balance_due < 0
					  OR COALESCE(i.due_date, i.created_at) > NOW() - INTERVAL '31 days'
				THEN i.balance_due ELSE 0 END)::float AS "bucket0_30",
			SUM(CASE WHEN i.balance_due > 0
					  AND COALESCE(i.due_date, i.created_at) <= NOW() - INTERVAL '31 days'
					  AND COALESCE(i.due_date, i.created_at) >  NOW() - INTERVAL '61 days'
				THEN i.balance_due ELSE 0 END)::float AS "bucket31_60",
			SUM(CASE WHEN i.balance_due > 0
					  AND COALESCE(i.due_date, i.created_at) <= NOW() - INTERVAL '61 days'
					  AND COALESCE(i.due_date, i.created_at) >  NOW() - INTERVAL '91 days'
				THEN i.balance_due ELSE 0 END)::float AS "bucket61_90",
			SUM(CASE WHEN i.balance_due > 0
					  AND COALESCE(i.due_date, i.created_at) <= NOW() - INTERVAL '91 days'
				THEN i.balance_due ELSE 0 END)::float AS "bucket90plus",
			SUM(i.balance_due)::float AS "total",
			COUNT(*)::int             AS "count"
		FROM invoice i
		JOIN client c ON c.id = i.client_id
		WHERE i.organization_id = ${organizationId}
			AND i.status NOT IN (${AR_EXCLUDED_STATUS_SQL})
			AND ${arCollectableSql("i.")}
		GROUP BY c.id, c.name
	`;

	const disputedRows = await sdb.$queryRaw<
		{ clientId: string; clientName: string; disputed: number | null; count: number }[]
	>`
		SELECT
			c.id   AS "clientId",
			c.name AS "clientName",
			SUM(i.balance_due)::float AS "disputed",
			COUNT(*)::int             AS "count"
		FROM invoice i
		JOIN client c ON c.id = i.client_id
		WHERE i.organization_id = ${organizationId}
			AND i.status = 'Disputed'
			AND ${arCollectableSql("i.")}
		GROUP BY c.id, c.name
	`;

	const byClient = new Map<
		string,
		{
			clientId: string;
			clientName: string;
			bucket0_30: number | null;
			bucket31_60: number | null;
			bucket61_90: number | null;
			bucket90plus: number | null;
			total: number | null;
			disputed: number | null;
			count: number;
		}
	>();

	for (const r of rows) byClient.set(r.clientId, { ...r, disputed: 0 });
	for (const d of disputedRows) {
		const existing = byClient.get(d.clientId);
		if (existing) {
			existing.disputed = d.disputed;
			existing.count += d.count;
		} else {
			byClient.set(d.clientId, {
				clientId: d.clientId,
				clientName: d.clientName,
				bucket0_30: 0,
				bucket31_60: 0,
				bucket61_90: 0,
				bucket90plus: 0,
				total: 0,
				disputed: d.disputed,
				count: d.count,
			});
		}
	}

	return [...byClient.values()]
		.map((r) => ({
			clientId: r.clientId,
			clientName: r.clientName,
			bucket0_30: round2(r.bucket0_30),
			bucket31_60: round2(r.bucket31_60),
			bucket61_90: round2(r.bucket61_90),
			bucket90plus: round2(r.bucket90plus),
			disputed: round2(r.disputed),
			// Rounded once, over the sum: round2(a) + round2(b) can land a cent
			// away from the buckets this total is meant to reconcile with.
			total: round2(Number(r.total ?? 0) + Number(r.disputed ?? 0)),
			count: r.count,
		}))
		.sort((a, b) => b.total - a.total);
};

export interface TaxLiabilityRow {
	rateKey: string;
	jurisdiction: string;
	rateName: string;
	rate: number;
	taxableBase: number;
	taxCollected: number;
	invoiceCount: number;
}

const UNCATEGORIZED_KEY = "__uncategorized__";
const QB_AST_KEY = "__qb_ast__";

export const getTaxLiabilityReport = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
): Promise<TaxLiabilityRow[]> => {
	const sdb = getScopedDb(organizationId);
	const dateFilter = buildDateFilter(startDate, endDate);

	const invoices = await sdb.invoice.findMany({
		where: {
			organization_id: organizationId,
			status: { notIn: ["Draft", "Void"] },
			...(Object.keys(dateFilter).length && {
				OR: [
					{ issue_date: dateFilter },
					{ issue_date: null, created_at: dateFilter },
				],
			}),
		},
		select: {
			id: true,
			tax_amount: true,
			tax_snapshot: true,
			tax_rate: true,
			subtotal: true,
			discount_amount: true,
		},
	});

	const acc = new Map<
		string,
		{
			jurisdiction: string;
			rateName: string;
			rate: number;
			taxableBaseCents: number;
			taxCollectedCents: number;
			invoiceIds: Set<string>;
		}
	>();

	const add = (
		key: string,
		jurisdiction: string,
		rateName: string,
		rate: number,
		taxableBaseCents: number,
		taxCollectedCents: number,
		invoiceId: string,
	) => {
		const existing = acc.get(key);
		if (existing) {
			existing.taxableBaseCents += taxableBaseCents;
			existing.taxCollectedCents += taxCollectedCents;
			existing.invoiceIds.add(invoiceId);
		} else {
			acc.set(key, {
				jurisdiction,
				rateName,
				rate,
				taxableBaseCents,
				taxCollectedCents,
				invoiceIds: new Set([invoiceId]),
			});
		}
	};

	for (const invoice of invoices) {
		const snapshot = invoice.tax_snapshot as TaxSnapshot | null;

		// QuickBooks computed this invoice's tax with no jurisdiction split; our estimate's
		// groups would report a figure the customer was never charged.
		const qbCents = qbAstTaxCents(snapshot);
		if (qbCents != null) {
			// A credit against an adopted invoice carries a negative qb_tax_cents and nets in here.
			if (qbCents !== 0) {
				add(
					QB_AST_KEY,
					"QuickBooks AST",
					"QuickBooks AST",
					0,
					(snapshot?.groups ?? []).reduce((sum, g) => sum + g.taxable_amount_cents, 0),
					qbCents,
					invoice.id,
				);
			}
			continue;
		}

		const hasGroups =
			snapshot != null &&
			snapshot.locked_at !== "draft" &&
			Array.isArray(snapshot.groups) &&
			snapshot.groups.length > 0;

		if (!hasGroups) {
			const taxAmountCents = dollarsToCents(Number(invoice.tax_amount));
			if (taxAmountCents > 0) {
				const rate = Number(invoice.tax_rate);
				const taxableBaseCents = Math.max(
					0,
					dollarsToCents(Number(invoice.subtotal) - Number(invoice.discount_amount)),
				);
				add(
					`${UNCATEGORIZED_KEY}:${rate}`,
					"Uncategorized",
					"Uncategorized",
					rate,
					taxableBaseCents,
					taxAmountCents,
					invoice.id,
				);
			}
			continue;
		}

		const halfUp = roundingFor(snapshot) === "jurisdiction_half_up";
		for (const group of snapshot.groups) {
			const taxableCents = group.taxable_amount_cents;
			// A half-up group was taxed one rate at a time on this same base, so recomputing
			// each rate reproduces the stored split exactly and leaves no remainder.
			const rawPerRate = group.rates.map((r) =>
				halfUp
					? roundHalfUpSymmetric(taxableCents * r.rate)
					: Math.floor(taxableCents * r.rate),
			);
			const rawSum = rawPerRate.reduce((sum, n) => sum + n, 0);
			const remainder = group.tax_amount_cents - rawSum;

			group.rates.forEach((r, idx) => {
				const isLast = idx === group.rates.length - 1;
				const rateTaxCents = rawPerRate[idx] + (isLast ? remainder : 0);
				const key = `${r.id}:${r.rate}`;
				add(
					key,
					r.jurisdiction ?? "—",
					r.name,
					r.rate,
					taxableCents,
					rateTaxCents,
					invoice.id,
				);
			});
		}
	}

	return Array.from(acc.entries())
		.filter(([, v]) => v.taxCollectedCents > 0)
		.map(([rateKey, v]) => ({
			rateKey,
			jurisdiction: v.jurisdiction,
			rateName: v.rateName,
			rate: v.rate,
			taxableBase: centsToDollars(v.taxableBaseCents),
			taxCollected: centsToDollars(v.taxCollectedCents),
			invoiceCount: v.invoiceIds.size,
		}))
		.sort((a, b) => b.taxCollected - a.taxCollected);
};

// ============================================================================
// JOBS
// ============================================================================

const JOBS_INCLUDE = {
	client: { select: { name: true } },
	_count: { select: { visits: true } },
} satisfies Prisma.jobInclude;

const jobsBaseWhere = (
	organizationId: string,
	startDate?: string,
	endDate?: string,
): Record<string, unknown> => {
	const dateFilter = buildDateFilter(startDate, endDate);
	return {
		organization_id: organizationId,
		...(Object.keys(dateFilter).length && { created_at: dateFilter }),
	};
};

const mapJobRaw = (job: Prisma.jobGetPayload<{ include: typeof JOBS_INCLUDE }>) => {
	const estimatedTotal = job.estimated_total != null ? Number(job.estimated_total) : null;
	const actualTotal = job.actual_total != null ? Number(job.actual_total) : null;
	const variance =
		estimatedTotal != null && actualTotal != null ? actualTotal - estimatedTotal : null;
	const source = job.quote_id
		? "Quote"
		: job.recurring_plan_id
			? "Recurring Plan"
			: job.request_id
				? "Request"
				: "Manual";

	return {
		id: job.id,
		jobNumber: job.job_number,
		name: job.name,
		clientName: job.client.name,
		status: job.status,
		priority: job.priority,
		jobType: job.recurring_plan_id ? "Recurring" : "One-off",
		source,
		address: job.address,
		createdAt: job.created_at,
		completedAt: job.completed_at,
		cancelledAt: job.cancelled_at,
		estimatedTotal,
		actualTotal,
		variance,
		subtotal: Number(job.subtotal),
		taxAmount: Number(job.tax_amount),
		discountAmount: job.discount_amount != null ? Number(job.discount_amount) : null,
		visitCount: job._count.visits,
	};
};

export const getJobsReport = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
) => {
	const sdb = getScopedDb(organizationId);
	const jobs = await sdb.job.findMany({
		where: jobsBaseWhere(organizationId, startDate, endDate),
		orderBy: { created_at: "desc" },
		include: JOBS_INCLUDE,
	});
	return jobs.map(mapJobRaw);
};

// j = job, c = client
export const JOBS_SQL_COLUMNS: ColumnMap = {
	jobNumber: t("j.job_number"),
	name: t("j.name"),
	clientName: t("c.name"),
	status: t("j.status::text"),
	priority: t("j.priority::text"),
	jobType: t("CASE WHEN j.recurring_plan_id IS NOT NULL THEN 'Recurring' ELSE 'One-off' END"),
	source: t(
		"CASE WHEN j.quote_id IS NOT NULL THEN 'Quote' WHEN j.recurring_plan_id IS NOT NULL THEN 'Recurring Plan' WHEN j.request_id IS NOT NULL THEN 'Request' ELSE 'Manual' END",
	),
	address: t("j.address"),
	createdAt: dt("j.created_at"),
	completedAt: dt("j.completed_at"),
	cancelledAt: dt("j.cancelled_at"),
	estimatedTotal: cur("j.estimated_total"),
	actualTotal: cur("j.actual_total"),
	variance: cur("(j.actual_total - j.estimated_total)"),
	subtotal: cur("j.subtotal"),
	taxAmount: cur("j.tax_amount"),
	discountAmount: cur("j.discount_amount"),
	visitCount: n('(SELECT COUNT(*) FROM "job_visit" v WHERE v.job_id = j.id)'),
};

export const getJobsReportPage = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
	params: PaginateParams,
): Promise<PageResult<ReturnType<typeof mapJobRaw>> | null> => {
	const sdb = getScopedDb(organizationId);
	const df = buildDateFilter(startDate, endDate);
	const baseParams: unknown[] = [organizationId];
	let baseWhere = "j.organization_id = $1";
	if (df.gte) baseWhere += ` AND j.created_at >= $${baseParams.push(df.gte)}`;
	if (df.lte) baseWhere += ` AND j.created_at <= $${baseParams.push(df.lte)}`;

	const res = await runIdPrefilter({
		sdb,
		from: '"job" j JOIN "client" c ON c.id = j.client_id',
		baseWhere,
		baseParams,
		idExpr: "j.id",
		columns: JOBS_SQL_COLUMNS,
		defaultOrder: { expr: "j.created_at", dir: "desc" },
		params,
		hydrate: (ids) => sdb.job.findMany({ where: { id: { in: ids } }, include: JOBS_INCLUDE }),
		rowId: (r) => r.id,
	});
	if (!res) return null;
	return { rows: res.rows.map(mapJobRaw), total: res.total, page: res.page, pageSize: res.pageSize };
};

// ============================================================================
// PROJECTS
// ============================================================================

const PROJECTS_INCLUDE = {
	client: { select: { name: true } },
	_count: { select: { jobs: true } },
	jobs: { select: { estimated_total: true, actual_total: true }},
	manager_dispatcher: { select: { name: true }}
} satisfies Prisma.projectInclude;

const projectsBaseWhere = (
	organizationId: string,
	startDate?: string,
	endDate?: string,
): Record<string, unknown> => {
	const dateFilter = buildDateFilter(startDate, endDate);
	return {
		organization_id: organizationId,
		...(Object.keys(dateFilter).length && { created_at: dateFilter }),
	};
};

// p = project, c = client, md = manager_dispatcher
export const PROJECTS_SQL_COLUMNS: ColumnMap = {
	projectNumber: t("p.project_number"),
	name: t("p.name"),
	clientName: t("c.name"),
	status: t("p.status::text"),
	priority: t("p.priority::text"),
	managerName: t("md.name"),
	address: t("p.address"),
	budget: cur("p.budget"),
	startsAt: dt("p.starts_at"),
	targetEndAt: dt("p.target_end_at"),
	createdAt: dt("p.created_at"),
	completedAt: dt("p.completed_at"),
	cancelledAt: dt("p.cancelled_at"),
	jobCount: n('(SELECT COUNT(*) FROM "job" j WHERE j.project_id = p.id)'),
	estimatedTotal: cur(
		'(SELECT CASE WHEN COUNT(j.id) = 0 THEN NULL ELSE COALESCE(SUM(j.estimated_total), 0) END FROM "job" j WHERE j.project_id = p.id)',
	),
	actualTotal: cur(
		'(SELECT CASE WHEN COUNT(j.id) = 0 THEN NULL ELSE COALESCE(SUM(j.actual_total), 0) END FROM "job" j WHERE j.project_id = p.id)',
	),
	variance: cur(
		'(SELECT CASE WHEN COUNT(j.id) = 0 THEN NULL ELSE COALESCE(SUM(j.actual_total), 0) - COALESCE(SUM(j.estimated_total), 0) END FROM "job" j WHERE j.project_id = p.id)',
	),
};

const mapProjectRaw = (project: Prisma.projectGetPayload<{ include: typeof PROJECTS_INCLUDE }>) => {
	const jobCount = project._count.jobs;
	const totals = project.jobs.reduce(
		(acc, j) => {
			acc.estimatedTotal += Number(j.estimated_total ?? 0);
			acc.actualTotal += Number(j.actual_total ?? 0);
			return acc;
		},
		{ estimatedTotal: 0, actualTotal: 0 },
	);
	const estimatedTotal = jobCount > 0 ? totals.estimatedTotal : null;
	const actualTotal = jobCount > 0 ? totals.actualTotal : null;
	const variance = jobCount > 0 ? totals.actualTotal - totals.estimatedTotal : null;

	return {
		id: project.id,
		projectNumber: project.project_number,
		name: project.name,
		clientName: project.client.name,
		status: project.status,
		priority: project.priority,
		managerName: project.manager_dispatcher?.name ?? null,
		address: project.address,
		startsAt: project.starts_at,
		targetEndAt: project.target_end_at,
		completedAt: project.completed_at,
		cancelledAt: project.cancelled_at,
		createdAt: project.created_at,
		budget: project.budget != null ? Number(project.budget) : null,
		estimatedTotal,
		actualTotal,
		variance,
		jobCount,
	};
};

export const getProjectsReport = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
) => {
	const sdb = getScopedDb(organizationId);
	const projects = await sdb.project.findMany({
		where: projectsBaseWhere(organizationId, startDate, endDate),
		orderBy: { created_at: "desc" },
		include: PROJECTS_INCLUDE,
	});
	
	return projects.map(mapProjectRaw);
}

export const getProjectsReportPage = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
	params: PaginateParams,
): Promise<PageResult<ReturnType<typeof mapProjectRaw>> | null> => {
	const sdb = getScopedDb(organizationId);
	const df = buildDateFilter(startDate, endDate);
	const baseParams: unknown[] = [organizationId];
	let baseWhere = "p.organization_id = $1";
	if (df.gte) baseWhere += ` AND p.created_at >= $${baseParams.push(df.gte)}`;
	if (df.lte) baseWhere += ` AND p.created_at <= $${baseParams.push(df.lte)}`;

	const res = await runIdPrefilter({
		sdb,
		from: '"project" p JOIN "client" c ON c.id = p.client_id LEFT JOIN "dispatcher" md ON md.id = p.manager_dispatcher_id',
		baseWhere,
		baseParams,
		idExpr: "p.id",
		columns: PROJECTS_SQL_COLUMNS,
		defaultOrder: { expr: "p.created_at", dir: "desc" },
		params,
		hydrate: (ids) => sdb.project.findMany({ where: { id: { in: ids } }, include: PROJECTS_INCLUDE }),
		rowId: (r) => r.id,
	});
	if (!res) return null;
	return { rows: res.rows.map(mapProjectRaw), total: res.total, page: res.page, pageSize: res.pageSize };
};

// ============================================================================
// FIRST-TIME FIX RATE
// ============================================================================

const FTFR_INCLUDE = {
	client: { select: { name: true } },
	_count: { select: { visits: { where: { status: { not: "Cancelled" } } } } },
} satisfies Prisma.jobInclude;

const mapFtfrRaw = (job: Prisma.jobGetPayload<{ include: typeof FTFR_INCLUDE }>) => ({
	id: job.id,
	jobNumber: job.job_number,
	name: job.name,
	clientName: job.client.name,
	completedAt: job.completed_at,
	visitCount: job._count.visits,
	firstTimeFix: job._count.visits === 1,
});

export const getFirstTimeFixReport = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
) => {
	const sdb = getScopedDb(organizationId);
	const dateFilter = buildDateFilter(startDate, endDate);
	const jobs = await sdb.job.findMany({
		where: {
			organization_id: organizationId,
			status: "Completed",
			visits: { some: { status: { not: "Cancelled" } } },
			...(Object.keys(dateFilter).length && { completed_at: dateFilter }),
		},
		orderBy: { completed_at: "desc" },
		include: FTFR_INCLUDE,
	});
	return jobs.map(mapFtfrRaw);
};

// ============================================================================
// INVOICES
// ============================================================================

const INVOICES_INCLUDE = { client: { select: { name: true } } } satisfies Prisma.invoiceInclude;

const invoicesBaseWhere = (
	organizationId: string,
	startDate?: string,
	endDate?: string,
): Record<string, unknown> => {
	const dateFilter = buildDateFilter(startDate, endDate);
	return {
		organization_id: organizationId,
		...(Object.keys(dateFilter).length && {
			OR: [{ issue_date: dateFilter }, { issue_date: null, created_at: dateFilter }],
		}),
	};
};

const mapInvoiceRaw = (invoice: Prisma.invoiceGetPayload<{ include: typeof INVOICES_INCLUDE }>) => {
	const balanceDue = Number(invoice.balance_due);
	const dueDate = invoice.due_date;
	const now = Date.now();
	const daysOverdue =
		balanceDue > 0 && dueDate && dueDate.getTime() < now
			? Math.floor((now - dueDate.getTime()) / DAY_MS)
			: 0;

	return {
		id: invoice.id,
		invoiceNumber: invoice.invoice_number,
		clientName: invoice.client.name,
		status: invoice.status,
		issueDate: invoice.issue_date,
		dueDate: invoice.due_date,
		paidAt: invoice.paid_at,
		sentAt: invoice.sent_at,
		total: Number(invoice.total),
		amountPaid: Number(invoice.amount_paid),
		balanceDue,
		subtotal: Number(invoice.subtotal),
		taxAmount: Number(invoice.tax_amount),
		daysOverdue,
		qbSyncStatus: invoice.qb_sync_status,
	};
};

export const getInvoicesReport = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
) => {
	const sdb = getScopedDb(organizationId);
	const invoices = await sdb.invoice.findMany({
		where: invoicesBaseWhere(organizationId, startDate, endDate),
		orderBy: { created_at: "desc" },
		include: INVOICES_INCLUDE,
	});
	return invoices.map(mapInvoiceRaw);
};

export const INVOICES_SQL_COLUMNS: ColumnMap = {
	invoiceNumber: t("i.invoice_number"),
	clientName: t("c.name"),
	status: t("i.status::text"),
	issueDate: dt("i.issue_date"),
	dueDate: dt("i.due_date"),
	paidAt: dt("i.paid_at"),
	sentAt: dt("i.sent_at"),
	total: cur("i.total"),
	amountPaid: cur("i.amount_paid"),
	balanceDue: cur("i.balance_due"),
	subtotal: cur("i.subtotal"),
	taxAmount: cur("i.tax_amount"),
	daysOverdue: n(
		"CASE WHEN i.balance_due > 0 AND i.due_date IS NOT NULL AND i.due_date < NOW() THEN FLOOR(EXTRACT(EPOCH FROM (NOW() - i.due_date)) / 86400) ELSE 0 END",
	),
	qbSyncStatus: t("i.qb_sync_status::text"),
};

export const getInvoicesReportPage = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
	params: PaginateParams,
): Promise<PageResult<ReturnType<typeof mapInvoiceRaw>> | null> => {
	const sdb = getScopedDb(organizationId);
	const df = buildDateFilter(startDate, endDate);
	const baseParams: unknown[] = [organizationId];
	let baseWhere = "i.organization_id = $1";
	if (df.gte || df.lte) {
		const issueConds: string[] = [];
		const createdConds: string[] = ["i.issue_date IS NULL"];
		if (df.gte) {
			const idx = baseParams.push(df.gte);
			issueConds.push(`i.issue_date >= $${idx}`);
			createdConds.push(`i.created_at >= $${idx}`);
		}
		if (df.lte) {
			const idx = baseParams.push(df.lte);
			issueConds.push(`i.issue_date <= $${idx}`);
			createdConds.push(`i.created_at <= $${idx}`);
		}
		baseWhere += ` AND ((${issueConds.join(" AND ")}) OR (${createdConds.join(" AND ")}))`;
	}

	const res = await runIdPrefilter({
		sdb,
		from: '"invoice" i JOIN "client" c ON c.id = i.client_id',
		baseWhere,
		baseParams,
		idExpr: "i.id",
		columns: INVOICES_SQL_COLUMNS,
		defaultOrder: { expr: "i.created_at", dir: "desc" },
		params,
		hydrate: (ids) => sdb.invoice.findMany({ where: { id: { in: ids } }, include: INVOICES_INCLUDE }),
		rowId: (r) => r.id,
	});
	if (!res) return null;
	return { rows: res.rows.map(mapInvoiceRaw), total: res.total, page: res.page, pageSize: res.pageSize };
};

// ============================================================================
// REVENUE BY LINE ITEM TYPE (revenue grouped by labor,material,equipment, or other)
// ============================================================================

// Fixed buckets in display order; null item_type folds into "other".
const LINE_ITEM_TYPES = [
	{ key: "labor", label: "Labor" },
	{ key: "material", label: "Material" },
	{ key: "equipment", label: "Equipment" },
	{ key: "other", label: "Other" },
] as const;

export const getRevenueByLineItemType = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
) => {
	const sdb = getScopedDb(organizationId);
	const df = buildDateFilter(startDate, endDate);

	const rows = await sdb.$queryRaw<{ itemType: string; revenue: number | null; lineCount: number }[]>`
		SELECT
			COALESCE(ili.item_type::text, 'other') AS "itemType",
			SUM(ili.total)::float                  AS "revenue",
			COUNT(*)::int                          AS "lineCount"
		FROM invoice_line_item ili
		JOIN invoice i ON i.id = ili.invoice_id
		WHERE i.organization_id = ${organizationId}
			AND i.status NOT IN ('Draft', 'Void')
			${df.gte ? Prisma.sql`AND COALESCE(i.issue_date, i.created_at) >= ${df.gte}` : Prisma.empty}
			${df.lte ? Prisma.sql`AND COALESCE(i.issue_date, i.created_at) <= ${df.lte}` : Prisma.empty}
		GROUP BY 1
	`;

	const byType = new Map(rows.map((r) => [r.itemType, r]));
	const totalRevenue = rows.reduce((sum, r) => sum + Number(r.revenue ?? 0), 0);

	return LINE_ITEM_TYPES.map(({ key, label }) => {
		const row = byType.get(key);
		const revenue = round2(Number(row?.revenue ?? 0));
		return {
			itemType: key,
			label,
			revenue,
			lineCount: row?.lineCount ?? 0,
			pctOfTotal: totalRevenue > 0 ? round2((revenue / totalRevenue) * 100) : 0,
		};
	});
};

// ============================================================================
// REVENUE LINE ITEMS (drilldown detail for Revenue by Line Item Type)
// ============================================================================

const REVENUE_LINE_ITEM_INCLUDE = {
	invoice: {
		select: {
			id: true,
			invoice_number: true,
			issue_date: true,
			client: { select: { name: true } },
		},
	},
} satisfies Prisma.invoice_line_itemInclude;

const revenueLineItemsWhere = (
	organizationId: string,
	startDate?: string,
	endDate?: string,
): Prisma.invoice_line_itemWhereInput => {
	const df = buildDateFilter(startDate, endDate);
	return {
		invoice: {
			organization_id: organizationId,
			status: { notIn: ["Draft", "Void"] },
			...(Object.keys(df).length && {
				OR: [{ issue_date: df }, { issue_date: null, created_at: df }],
			}),
		},
	};
};

const mapRevenueLineItemRaw = (
	li: Prisma.invoice_line_itemGetPayload<{ include: typeof REVENUE_LINE_ITEM_INCLUDE }>,
) => ({
	id: li.id,
	invoiceId: li.invoice.id,
	invoiceNumber: li.invoice.invoice_number,
	clientName: li.invoice.client.name,
	issueDate: li.invoice.issue_date,
	name: li.name,
	description: li.description,
	quantity: Number(li.quantity),
	unitPrice: Number(li.unit_price),
	total: Number(li.total),
	itemType: li.item_type ?? "other",
});

// Capped like the other in-memory reports; `truncated` is surfaced so the
// fallback/export path can say the sheet is incomplete instead of passing off a
// short list as the whole period.
export const getRevenueLineItemsReport = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
): Promise<{ rows: ReturnType<typeof mapRevenueLineItemRaw>[]; truncated: boolean }> => {
	const sdb = getScopedDb(organizationId);
	const items = await sdb.invoice_line_item.findMany({
		where: revenueLineItemsWhere(organizationId, startDate, endDate),
		orderBy: { invoice: { issue_date: "desc" } },
		include: REVENUE_LINE_ITEM_INCLUDE,
		take: REPORT_ROW_CAP,
	});
	return { rows: items.map(mapRevenueLineItemRaw), truncated: items.length >= REPORT_ROW_CAP };
};

export const REVENUE_LINE_ITEM_SQL_COLUMNS: ColumnMap = {
	invoiceNumber: t("i.invoice_number"),
	clientName: t("c.name"),
	issueDate: dt("i.issue_date"),
	name: t("ili.name"),
	description: t("ili.description"),
	quantity: n("ili.quantity"),
	unitPrice: cur("ili.unit_price"),
	total: cur("ili.total"),
	// COALESCE folds null → 'other' so the type filter matches the aggregate's Other bucket
	itemType: t("COALESCE(ili.item_type::text, 'other')"),
};

export const getRevenueLineItemsReportPage = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
	params: PaginateParams,
): Promise<PageResult<ReturnType<typeof mapRevenueLineItemRaw>> | null> => {
	const sdb = getScopedDb(organizationId);
	const df = buildDateFilter(startDate, endDate);
	const baseParams: unknown[] = [organizationId];
	let baseWhere = "i.organization_id = $1 AND i.status NOT IN ('Draft', 'Void')";
	if (df.gte) {
		const idx = baseParams.push(df.gte);
		baseWhere += ` AND COALESCE(i.issue_date, i.created_at) >= $${idx}`;
	}
	if (df.lte) {
		const idx = baseParams.push(df.lte);
		baseWhere += ` AND COALESCE(i.issue_date, i.created_at) <= $${idx}`;
	}

	const res = await runIdPrefilter({
		sdb,
		from: '"invoice_line_item" ili JOIN "invoice" i ON i.id = ili.invoice_id JOIN "client" c ON c.id = i.client_id',
		baseWhere,
		baseParams,
		idExpr: "ili.id",
		columns: REVENUE_LINE_ITEM_SQL_COLUMNS,
		defaultOrder: { expr: "i.issue_date", dir: "desc" },
		params,
		hydrate: (ids) =>
			sdb.invoice_line_item.findMany({ where: { id: { in: ids } }, include: REVENUE_LINE_ITEM_INCLUDE }),
		rowId: (r) => r.id,
	});
	if (!res) return null;
	return { rows: res.rows.map(mapRevenueLineItemRaw), total: res.total, page: res.page, pageSize: res.pageSize };
};

// ============================================================================
// CLIENTS
// ============================================================================

export const getClientsReport = async (organizationId: string) => {
	const sdb = getScopedDb(organizationId);

	const rows = await sdb.$queryRaw<
		{
			id: string;
			name: string;
			isActive: boolean;
			isTaxExempt: boolean;
			createdAt: Date;
			lastActivity: Date;
			jobCount: number;
			invoiceCount: number;
			lifetimeRevenue: number | null;
			openBalance: number | null;
			primaryContact: string | null;
			email: string | null;
			phone: string | null;
			address: string;
			contactCount: number;
			taxGroup: string | null;
			taxRate: number | null;
		}[]
	>`
		SELECT
			c.id            AS "id",
			c.name          AS "name",
			c.is_active     AS "isActive",
			c.is_tax_exempt AS "isTaxExempt",
			c.created_at    AS "createdAt",
			c.last_activity AS "lastActivity",
			c.address       AS "address",
			pc.name         AS "primaryContact",
			pc.email        AS "email",
			pc.phone        AS "phone",
			tg.name         AS "taxGroup",
			c.tax_rate      AS "taxRate",
			COALESCE(cct.contact_count, 0)::int     AS "contactCount",
			COALESCE(j.job_count, 0)::int           AS "jobCount",
			COALESCE(inv.invoice_count, 0)::int     AS "invoiceCount",
			COALESCE(inv.lifetime_revenue, 0)::float AS "lifetimeRevenue",
			COALESCE(inv.open_balance, 0)::float    AS "openBalance"
		FROM client c
		LEFT JOIN tax_group tg ON tg.id = c.tax_group_id
		LEFT JOIN LATERAL (
			SELECT ct.name, ct.email, ct.phone
			FROM client_contact cc
			JOIN contact ct ON ct.id = cc.contact_id
			WHERE cc.client_id = c.id
			ORDER BY cc.is_primary DESC, cc.is_billing DESC
			LIMIT 1
		) pc ON true
		LEFT JOIN (
			SELECT client_id, COUNT(*) AS contact_count
			FROM client_contact
			GROUP BY client_id
		) cct ON cct.client_id = c.id
		LEFT JOIN (
			SELECT client_id, COUNT(*) AS job_count
			FROM job
			WHERE organization_id = ${organizationId}
			GROUP BY client_id
		) j ON j.client_id = c.id
		LEFT JOIN (
			SELECT client_id,
				COUNT(*)         AS invoice_count,
				SUM(amount_paid) AS lifetime_revenue,
				SUM(balance_due) AS open_balance
			FROM invoice
			WHERE organization_id = ${organizationId}
			AND status NOT IN ('Draft', 'Void')
			GROUP BY client_id
		) inv ON inv.client_id = c.id
		WHERE c.organization_id = ${organizationId}
		ORDER BY "lifetimeRevenue" DESC
	`;

	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		status: r.isActive ? "Active" : "Inactive",
		taxExempt: r.isTaxExempt ? "Yes" : "No",
		primaryContact: r.primaryContact,
		email: r.email,
		phone: r.phone,
		address: r.address,
		contactCount: r.contactCount,
		taxGroup: r.taxGroup,
		taxRate: r.taxRate != null ? Number(r.taxRate) : null,
		createdAt: r.createdAt,
		lastActivity: r.lastActivity,
		jobCount: r.jobCount,
		invoiceCount: r.invoiceCount,
		lifetimeRevenue: round2(r.lifetimeRevenue),
		openBalance: round2(r.openBalance),
	}));
};

// ============================================================================
// CLIENT RETENTION
// ============================================================================

// Active clients with no purchase, service, or communication within #
export const getClientRetentionReport = async (
	organizationId: string,
	opts: { lookbackDays: number },
) => {
	const sdb = getScopedDb(organizationId);
	const cutoff = new Date(Date.now() - opts.lookbackDays * DAY_MS);

	const rows = await sdb.$queryRaw<
		{
			id: string;
			name: string;
			primaryContact: string | null;
			email: string | null;
			phone: string | null;
			lastActivityAt: Date | null;
			jobCount: number;
			lifetimeRevenue: number | null;
		}[]
	>`
		WITH purchase AS (
			SELECT i.client_id, MAX(ip.paid_at) AS ts
			FROM invoice i
			JOIN invoice_payment ip ON ip.invoice_id = i.id
			WHERE i.organization_id = ${organizationId}
			GROUP BY i.client_id
		),
		service AS (
			SELECT client_id, MAX(created_at) AS ts FROM (
				SELECT client_id, created_at FROM request WHERE organization_id = ${organizationId}
				UNION ALL
				SELECT client_id, created_at FROM job WHERE organization_id = ${organizationId}
				UNION ALL
				SELECT client_id, created_at FROM quote WHERE organization_id = ${organizationId}
			) s
			GROUP BY client_id
		),
		comm AS (
			SELECT client_id, MAX(ts) AS ts FROM (
				SELECT client_id, created_at AS ts FROM client_note WHERE organization_id = ${organizationId}
				UNION ALL
				SELECT client_id, sent_at AS ts FROM quote WHERE organization_id = ${organizationId} AND sent_at IS NOT NULL
				UNION ALL
				SELECT client_id, viewed_at AS ts FROM quote WHERE organization_id = ${organizationId} AND viewed_at IS NOT NULL
				UNION ALL
				SELECT client_id, sent_at AS ts FROM invoice WHERE organization_id = ${organizationId} AND sent_at IS NOT NULL
				UNION ALL
				SELECT client_id, viewed_at AS ts FROM invoice WHERE organization_id = ${organizationId} AND viewed_at IS NOT NULL
			) c
			GROUP BY client_id
		)
		SELECT * FROM (
			SELECT
				c.id   AS "id",
				c.name AS "name",
				pc.name  AS "primaryContact",
				pc.email AS "email",
				pc.phone AS "phone",
				GREATEST(p.ts, s.ts, cm.ts) AS "lastActivityAt",
				COALESCE(j.job_count, 0)::int           AS "jobCount",
				COALESCE(inv.lifetime_revenue, 0)::float AS "lifetimeRevenue"
			FROM client c
			LEFT JOIN LATERAL (
				SELECT ct.name, ct.email, ct.phone
				FROM client_contact cc
				JOIN contact ct ON ct.id = cc.contact_id
				WHERE cc.client_id = c.id
				ORDER BY cc.is_primary DESC, cc.is_billing DESC
				LIMIT 1
			) pc ON true
			LEFT JOIN purchase p ON p.client_id = c.id
			LEFT JOIN service s ON s.client_id = c.id
			LEFT JOIN comm cm ON cm.client_id = c.id
			LEFT JOIN (
				SELECT client_id, COUNT(*) AS job_count
				FROM job
				WHERE organization_id = ${organizationId}
				GROUP BY client_id
			) j ON j.client_id = c.id
			LEFT JOIN (
				SELECT client_id, SUM(amount_paid) AS lifetime_revenue
				FROM invoice
				WHERE organization_id = ${organizationId}
				GROUP BY client_id
			) inv ON inv.client_id = c.id
			WHERE c.organization_id = ${organizationId}
				AND c.is_active = true
		) t
		WHERE t."lastActivityAt" < ${cutoff}
		ORDER BY t."lastActivityAt" DESC
	`;

	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		primaryContact: r.primaryContact,
		email: r.email,
		phone: r.phone,
		lastActivityAt: r.lastActivityAt,
		jobCount: r.jobCount,
		lifetimeRevenue: round2(r.lifetimeRevenue),
	}));
};

// ============================================================================
// CLIENT LIFETIME VALUE
// ============================================================================

const MS_PER_MONTH = DAY_MS * 30.437;

export const getClientLifetimeValueReport = async (organizationId: string) => {
	const sdb = getScopedDb(organizationId);

	const rows = await sdb.$queryRaw<
		{
			id: string;
			name: string;
			primaryContact: string | null;
			firstPurchaseAt: Date;
			jobCount: number;
			invoiceCount: number;
			lifetimeRevenue: number | null;
		}[]
	>`
		WITH pay AS (
			SELECT i.client_id, MIN(ip.paid_at) AS first_purchase_at
			FROM invoice i
			JOIN invoice_payment ip ON ip.invoice_id = i.id
			WHERE i.organization_id = ${organizationId}
				AND i.status NOT IN ('Draft', 'Void')
			GROUP BY i.client_id
		),
		rev AS (
			SELECT client_id,
				SUM(amount_paid) AS lifetime_revenue,
				COUNT(*) FILTER (WHERE amount_paid > 0) AS invoice_count
			FROM invoice
			WHERE organization_id = ${organizationId}
				AND status NOT IN ('Draft', 'Void')
			GROUP BY client_id
		),
		jobs AS (
			SELECT client_id, COUNT(*) AS job_count
			FROM job
			WHERE organization_id = ${organizationId}
			GROUP BY client_id
		)
		SELECT
			c.id   AS "id",
			c.name AS "name",
			pc.name AS "primaryContact",
			p.first_purchase_at AS "firstPurchaseAt",
			COALESCE(j.job_count, 0)::int          AS "jobCount",
			COALESCE(r.invoice_count, 0)::int      AS "invoiceCount",
			COALESCE(r.lifetime_revenue, 0)::float AS "lifetimeRevenue"
		FROM client c
		JOIN pay p ON p.client_id = c.id
		JOIN rev r ON r.client_id = c.id
		LEFT JOIN LATERAL (
			SELECT ct.name
			FROM client_contact cc
			JOIN contact ct ON ct.id = cc.contact_id
			WHERE cc.client_id = c.id
			ORDER BY cc.is_primary DESC, cc.is_billing DESC
			LIMIT 1
		) pc ON true
		LEFT JOIN jobs j ON j.client_id = c.id
		WHERE c.organization_id = ${organizationId}
			AND c.is_active = true
		ORDER BY r.lifetime_revenue DESC
	`;

	const now = Date.now();
	return rows.map((r) => {
		const lifetimeRevenue = round2(r.lifetimeRevenue ?? 0);
		return {
			id: r.id,
			name: r.name,
			primaryContact: r.primaryContact,
			firstPurchaseAt: r.firstPurchaseAt,
			tenureMonths: Math.round((now - r.firstPurchaseAt.getTime()) / MS_PER_MONTH),
			jobCount: r.jobCount,
			invoiceCount: r.invoiceCount,
			lifetimeRevenue,
			avgInvoiceValue: r.invoiceCount ? round2(lifetimeRevenue / r.invoiceCount) : 0,
		};
	});
};

// ============================================================================
// DISCOUNTING BY CLIENT
// ============================================================================

// Realized (billed) discounts per client across issued invoices, ranked by
// total discount given. Only clients that actually received a discount appear.
export const getClientDiscountsReport = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
) => {
	const sdb = getScopedDb(organizationId);
	const df = buildDateFilter(startDate, endDate);

	const rows = await sdb.$queryRaw<
		{
			clientId: string;
			clientName: string;
			invoiceCount: number;
			totalBilled: number | null;
			totalDiscount: number | null;
		}[]
	>`
		SELECT
			c.id   AS "clientId",
			c.name AS "clientName",
			COUNT(*) FILTER (WHERE i.discount_amount > 0)::int AS "invoiceCount",
			SUM(i.subtotal)::float                            AS "totalBilled",
			SUM(i.discount_amount)::float                     AS "totalDiscount"
		FROM invoice i
		JOIN client c ON c.id = i.client_id
		WHERE i.organization_id = ${organizationId}
			AND i.status NOT IN ('Draft', 'Void')
			${df.gte ? Prisma.sql`AND COALESCE(i.issue_date, i.created_at) >= ${df.gte}` : Prisma.empty}
			${df.lte ? Prisma.sql`AND COALESCE(i.issue_date, i.created_at) <= ${df.lte}` : Prisma.empty}
		GROUP BY c.id, c.name
		HAVING SUM(i.discount_amount) > 0
		ORDER BY "totalDiscount" DESC
	`;

	return rows.map((r) => {
		const totalBilled = round2(r.totalBilled ?? 0);
		const totalDiscount = round2(r.totalDiscount ?? 0);
		return {
			clientId: r.clientId,
			clientName: r.clientName,
			invoiceCount: r.invoiceCount,
			totalBilled,
			totalDiscount,
			discountRate: totalBilled > 0 ? round2((totalDiscount / totalBilled) * 100) : 0,
			avgDiscount: r.invoiceCount ? round2(totalDiscount / r.invoiceCount) : 0,
		};
	});
};

// ============================================================================
// FIELD-ADDED REVENUE (TECH UPSELL)
// ============================================================================

export interface FieldAddedRevenueRow {
	techId: string;
	techName: string;
	itemCount: number;
	jobCount: number;
	fieldAddedRevenue: number;
	avgPerItem: number;
}

export interface FieldAddedRevenueTrend {
	// Filter options, ordered by revenue desc (same order as rows), incl. "Unassigned".
	techs: { id: string; name: string }[];
	// Long format: one entry per (tech, month) with field-added revenue.
	points: { month: string; techId: string; revenue: number }[];
}

const UNASSIGNED_TECH_ID = "__unassigned__";

type FieldAddedItem = {
	total: Prisma.Decimal | number;
	reconciled_by_tech_id: string | null;
	visit: {
		job_id: string;
		scheduled_start_at: Date;
		visit_techs: { tech: { id: string; name: string } }[];
	};
};

// "2026-08-14T…" → "2026-08" (UTC, matching buildDateFilter's UTC handling).
const monthKey = (d: Date) =>
	`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

// Attributes each field-addition line to a technician (reconciled_by_tech_id when set,
// otherwise split evenly across the visit's assigned techs, otherwise "Unassigned") and
// builds both the per-tech table rows and the per-(tech, month) revenue trend.
export const aggregateFieldAdded = (
	items: FieldAddedItem[],
	techNames: Map<string, string>,
): { rows: FieldAddedRevenueRow[]; trend: FieldAddedRevenueTrend } => {
	type Acc = { revenue: number; itemCount: number; jobs: Set<string> };
	const byTech = new Map<string, Acc>();
	const byTechMonth = new Map<string, Map<string, number>>();
	const bump = (techId: string, revenue: number, jobId: string, month: string) => {
		const acc = byTech.get(techId) ?? { revenue: 0, itemCount: 0, jobs: new Set<string>() };
		acc.revenue += revenue;
		acc.itemCount += 1;
		acc.jobs.add(jobId);
		byTech.set(techId, acc);

		const months = byTechMonth.get(techId) ?? new Map<string, number>();
		months.set(month, (months.get(month) ?? 0) + revenue);
		byTechMonth.set(techId, months);
	};

	for (const item of items) {
		const total = Number(item.total);
		const jobId = item.visit.job_id;
		const month = monthKey(item.visit.scheduled_start_at);
		if (item.reconciled_by_tech_id) {
			bump(item.reconciled_by_tech_id, total, jobId, month);
			continue;
		}
		const visitTechs = item.visit.visit_techs;
		if (visitTechs.length === 0) {
			bump(UNASSIGNED_TECH_ID, total, jobId, month);
			continue;
		}
		const share = total / visitTechs.length;
		for (const { tech } of visitTechs) bump(tech.id, share, jobId, month);
	}

	const nameFor = (techId: string) =>
		techId === UNASSIGNED_TECH_ID ? "Unassigned" : (techNames.get(techId) ?? "Unknown");

	const rows = [...byTech.entries()]
		.map(([techId, acc]) => ({
			techId,
			techName: nameFor(techId),
			itemCount: acc.itemCount,
			jobCount: acc.jobs.size,
			fieldAddedRevenue: round2(acc.revenue),
			avgPerItem: acc.itemCount ? round2(acc.revenue / acc.itemCount) : 0,
		}))
		.sort((a, b) => b.fieldAddedRevenue - a.fieldAddedRevenue);

	const techs = rows.map((r) => ({ id: r.techId, name: r.techName }));
	const points = rows.flatMap((r) =>
		[...(byTechMonth.get(r.techId) ?? new Map<string, number>())].map(([month, revenue]) => ({
			month,
			techId: r.techId,
			revenue: round2(revenue),
		})),
	);

	return { rows, trend: { techs, points } };
};

// Revenue on line items techs added in the field (source = field_addition),
// grouped by technician. Job-level field additions (job_line_item) are excluded:
// they have no visit and no tech link, so they can't be attributed. Each item is
// credited to reconciled_by_tech_id when set, otherwise split evenly across the
// visit's assigned techs (matching getTechnicianScorecard's revenue split).
export const getFieldAddedRevenueReport = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
): Promise<{
	rows: FieldAddedRevenueRow[];
	orgVisitRevenue: number;
	fieldAddedItemCount: number;
	truncated: boolean;
	trend: FieldAddedRevenueTrend;
}> => {
	const sdb = getScopedDb(organizationId);
	const dateFilter = buildDateFilter(startDate, endDate);
	// Completed visits only (same as the technician scorecard): a line added on a
	// Scheduled/Paused/Cancelled visit is not realized revenue yet, or ever.
	const visitWhere = {
		job: { organization_id: organizationId },
		status: "Completed" as const,
		...(Object.keys(dateFilter).length && { scheduled_start_at: dateFilter }),
	};

	const [items, revenueAgg, techs] = await Promise.all([
		// Newest first, so the row cap drops the oldest items rather than an
		// arbitrary set; `truncated` tells the page the totals are partial.
		sdb.job_visit_line_item.findMany({
			where: { source: "field_addition", visit: visitWhere },
			select: {
				total: true,
				reconciled_by_tech_id: true,
				visit: {
					select: {
						job_id: true,
						scheduled_start_at: true,
						visit_techs: { select: { tech: { select: { id: true, name: true } } } },
					},
				},
			},
			orderBy: { visit: { scheduled_start_at: "desc" } },
			take: REPORT_ROW_CAP,
		}),
		// Upsell-rate: all visit line-item revenue
		sdb.job_visit_line_item.aggregate({
			where: { visit: visitWhere },
			_sum: { total: true },
		}),
		sdb.technician.findMany({
			where: { organization_id: organizationId },
			select: { id: true, name: true },
		}),
	]);

	const techNames = new Map<string, string>(techs.map((t) => [t.id, t.name]));
	const { rows, trend } = aggregateFieldAdded(items, techNames);

	return {
		rows,
		orgVisitRevenue: round2(Number(revenueAgg._sum.total ?? 0)),
		// Distinct line items. Per-tech itemCount credits a split item to every tech
		// on the visit, so summing those would overstate this.
		fieldAddedItemCount: items.length,
		truncated: items.length >= REPORT_ROW_CAP,
		trend,
	};
};

// ============================================================================
// RECURRING REVENUE (MRR)
// ============================================================================

export interface RecurringRevenueRow {
	planId: string;
	clientName: string;
	name: string;
	status: string;
	billingBasis: string;
	perPeriodAmount: number | null;
	monthlyValue: number;
	nextInvoiceAt: Date | null;
	lastInvoicedAt: Date | null;
	occCompleted: number;
	occSkipped: number;
}

export interface RecurringRevenueTrendPoint {
	month: string; // YYYY-MM
	revenue: number;
}

const TRAILING_DAYS = 90;
const TREND_MONTHS = 12;

// Forward-looking recurring run-rate + plan health. MRR normalizes each active
// plan's per-period amount to a month (deterministic bases) or estimates it from
// the plan's trailing-90d invoiced revenue (variable bases). See recurringRevenue.ts.
export const getRecurringRevenueReport = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
) => {
	const sdb = getScopedDb(organizationId);
	const df = buildDateFilter(startDate, endDate);
	const now = new Date();
	const trailingStart = new Date(now.getTime() - TRAILING_DAYS * 24 * 60 * 60 * 1000);
	// UTC to match date_trunc in the trend query and the gap-fill keys below.
	const trendStart = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (TREND_MONTHS - 1), 1),
	);
	// "New" is a fixed trailing-30-day window, independent of the report period.
	const newSince = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

	const [plans, trailing, churnedTrailing, occGroups, trendRaw] = await Promise.all([
		sdb.recurring_plan.findMany({
			where: { organization_id: organizationId },
			include: {
				client: { select: { name: true } },
				invoice_schedule: true,
				line_items: { select: { quantity: true, unit_price: true } },
			},
		}),
		// Trailing-90d invoiced revenue per plan → variable-basis MRR estimate.
		sdb.invoice.groupBy({
			by: ["recurring_plan_id"],
			where: {
				organization_id: organizationId,
				recurring_plan_id: { not: null },
				status: { notIn: ["Draft", "Void"] },
				OR: [
					{ issue_date: { gte: trailingStart } },
					{ issue_date: null, created_at: { gte: trailingStart } },
				],
			},
			_sum: { total: true },
		}),
		// Same 90-day window, but anchored at each churned plan's end date rather
		// than now: a variable-basis plan cancelled more than 90 days ago has no
		// live trailing revenue, yet the MRR it took with it is what churnedMrr
		// reports. Anchor matches the churn date used below (ends_at ?? updated_at).
		sdb.$queryRaw<{ planId: string; revenue: number | null }[]>`
			SELECT p.id AS "planId", SUM(i.total)::float AS revenue
			FROM recurring_plan p
			JOIN invoice i ON i.recurring_plan_id = p.id
			WHERE p.organization_id = ${organizationId}
			  AND p.status IN ('Cancelled', 'Completed')
			  AND i.status NOT IN ('Draft', 'Void')
			  AND COALESCE(i.issue_date, i.created_at) <= COALESCE(p.ends_at, p.updated_at)
			  AND COALESCE(i.issue_date, i.created_at) >= COALESCE(p.ends_at, p.updated_at) - ${TRAILING_DAYS} * INTERVAL '1 day'
			GROUP BY p.id
		`,
		sdb.recurring_occurrence.groupBy({
			by: ["recurring_plan_id", "status"],
			where: {
				recurring_plan: { organization_id: organizationId },
				...(Object.keys(df).length && { occurrence_start_at: df }),
			},
			_count: { _all: true },
		}),
		// 12-month realized recurring revenue trend 
		sdb.$queryRaw<{ month: string; revenue: number }[]>`
			SELECT to_char(date_trunc('month', COALESCE(i.issue_date, i.created_at)), 'YYYY-MM') AS month,
			       SUM(i.total)::float AS revenue
			FROM invoice i
			WHERE i.organization_id = ${organizationId}
			  AND i.recurring_plan_id IS NOT NULL
			  AND i.status NOT IN ('Draft', 'Void')
			  AND COALESCE(i.issue_date, i.created_at) >= ${trendStart}
			GROUP BY 1
			ORDER BY 1
		`,
	]);

	const trailingMap = new Map<string, number>();
	for (const t of trailing) {
		if (t.recurring_plan_id) trailingMap.set(t.recurring_plan_id, Number(t._sum.total ?? 0));
	}
	const churnedTrailingMap = new Map<string, number>(
		churnedTrailing.map((r) => [r.planId, Number(r.revenue ?? 0)]),
	);

	const occByPlan = new Map<string, { completed: number; skipped: number }>();
	let occCompletedTotal = 0;
	let occSkippedTotal = 0;
	let occCancelledTotal = 0;
	for (const g of occGroups) {
		const n = g._count._all;
		const bucket = occByPlan.get(g.recurring_plan_id) ?? { completed: 0, skipped: 0 };
		if (g.status === "completed") {
			bucket.completed += n;
			occCompletedTotal += n;
		} else if (g.status === "skipped") {
			bucket.skipped += n;
			occSkippedTotal += n;
		} else if (g.status === "cancelled") {
			occCancelledTotal += n;
		}
		occByPlan.set(g.recurring_plan_id, bucket);
	}

	const inRange = (d: Date | null): boolean =>
		d != null && (!df.gte || d >= df.gte) && (!df.lte || d <= df.lte);

	const isChurned = (plan: (typeof plans)[number]): boolean =>
		plan.status === "Cancelled" || plan.status === "Completed";

	const monthlyValueOf = (plan: (typeof plans)[number]): number => {
		const schedule = plan.invoice_schedule;
		const perPeriod = planPerPeriodAmount({
			billing_basis: (schedule?.billing_basis ?? null) as BillingBasis | null,
			fixed_amount: schedule?.fixed_amount != null ? Number(schedule.fixed_amount) : null,
			line_items: plan.line_items.map((li) => ({
				quantity: Number(li.quantity),
				unit_price: Number(li.unit_price),
			})),
		});
		// on_visit_completion has no fixed cadence, so even a deterministic
		// per-period amount can't be normalized — fall back to trailing actuals.
		if (perPeriod != null && schedule && schedule.frequency !== "on_visit_completion") {
			return normalizedMonthly(perPeriod, schedule.frequency as ScheduleFrequency);
		}
		// Churned plans read their trailing window as of when they ended.
		const trailingRevenue = isChurned(plan)
			? (churnedTrailingMap.get(plan.id) ?? 0)
			: (trailingMap.get(plan.id) ?? 0);
		return trailingRevenue / (TRAILING_DAYS / 30);
	};

	const perPeriodOf = (plan: (typeof plans)[number]): number | null =>
		planPerPeriodAmount({
			billing_basis: (plan.invoice_schedule?.billing_basis ?? null) as BillingBasis | null,
			fixed_amount:
				plan.invoice_schedule?.fixed_amount != null
					? Number(plan.invoice_schedule.fixed_amount)
					: null,
			line_items: plan.line_items.map((li) => ({
				quantity: Number(li.quantity),
				unit_price: Number(li.unit_price),
			})),
		});

	let mrr = 0;
	let activePlans = 0;
	let pausedPlans = 0;
	let newPlans = 0;
	let churnedPlans = 0;
	let churnedMrr = 0;

	const rows: RecurringRevenueRow[] = plans.map((plan) => {
		const monthly = round2(monthlyValueOf(plan));
		// A plan whose ends_at has passed is finished even if nothing flipped its
		// status yet: it neither counts as active nor contributes to MRR.
		const isActive =
			plan.status === "Active" && (!plan.ends_at || new Date(plan.ends_at) > now);
		if (isActive) {
			mrr += monthly;
			activePlans++;
		}
		if (plan.status === "Paused") pausedPlans++;
		if (plan.starts_at >= newSince) newPlans++;
		if (isChurned(plan) && inRange(plan.ends_at ?? plan.updated_at)) {
			churnedPlans++;
			churnedMrr += monthly;
		}
		const occ = occByPlan.get(plan.id) ?? { completed: 0, skipped: 0 };
		return {
			planId: plan.id,
			clientName: plan.client.name,
			name: plan.name,
			status: plan.status,
			billingBasis: plan.invoice_schedule?.billing_basis ?? "none",
			perPeriodAmount: perPeriodOf(plan),
			monthlyValue: monthly,
			nextInvoiceAt: plan.invoice_schedule?.next_invoice_at ?? null,
			lastInvoicedAt: plan.invoice_schedule?.last_invoiced_at ?? null,
			occCompleted: occ.completed,
			occSkipped: occ.skipped,
		};
	});
	rows.sort((a, b) => b.monthlyValue - a.monthlyValue);

	const decidedOcc = occCompletedTotal + occSkippedTotal;
	const completionRate = decidedOcc > 0 ? round2((occCompletedTotal / decidedOcc) * 100) : 0;
	const skipRateDenom = occCompletedTotal + occSkippedTotal + occCancelledTotal;
	const skipRate = skipRateDenom > 0 ? round2((occSkippedTotal / skipRateDenom) * 100) : 0;
	const trendMap = new Map(trendRaw.map((r) => [r.month, round2(Number(r.revenue ?? 0))]));
	const trend: RecurringRevenueTrendPoint[] = [];
	for (let i = 0; i < TREND_MONTHS; i++) {
		const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (TREND_MONTHS - 1) + i, 1));
		const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
		trend.push({ month: key, revenue: trendMap.get(key) ?? 0 });
	}

	return {
		mrr: round2(mrr),
		arr: round2(mrr * 12),
		activePlans,
		pausedPlans,
		newPlans,
		churnedPlans,
		churnedMrr: round2(churnedMrr),
		completionRate,
		skipRate,
		trend,
		plans: rows,
	};
};

// ============================================================================
// PAYMENTS COLLECTED
// ============================================================================

const PAYMENTS_INCLUDE = {
	invoice: {
		select: {
			id: true,
			invoice_number: true,
			client: { select: { name: true } },
		},
	},
	recorded_by_dispatcher: { select: { name: true } },
	recorded_by_tech: { select: { name: true } },
} satisfies Prisma.invoice_paymentInclude;

const paymentsBaseWhere = (
	organizationId: string,
	startDate?: string,
	endDate?: string,
): Record<string, unknown> => {
	const dateFilter = buildDateFilter(startDate, endDate);
	return {
		invoice: { organization_id: organizationId },
		...(Object.keys(dateFilter).length && { paid_at: dateFilter }),
	};
};

const mapPaymentRaw = (
	p: Prisma.invoice_paymentGetPayload<{ include: typeof PAYMENTS_INCLUDE }>,
) => ({
	paymentId: p.id,
	paidAt: p.paid_at,
	invoiceId: p.invoice.id,
	invoiceNumber: p.invoice.invoice_number,
	clientName: p.invoice.client.name,
	amount: Number(p.amount),
	method: p.method,
	note: p.note,
	recordedBy: p.recorded_by_dispatcher?.name ?? p.recorded_by_tech?.name ?? null,
	qbSynced: !!p.qb_payment_id,
});

export const getPaymentsReport = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
) => {
	const sdb = getScopedDb(organizationId);
	const payments = await sdb.invoice_payment.findMany({
		where: paymentsBaseWhere(organizationId, startDate, endDate),
		orderBy: { paid_at: "desc" },
		include: PAYMENTS_INCLUDE,
	});
	return payments.map(mapPaymentRaw);
};

const PAYMENTS_FROM =
	'"invoice_payment" p JOIN "invoice" i ON i.id = p.invoice_id JOIN "client" c ON c.id = i.client_id LEFT JOIN "dispatcher" disp ON disp.id = p.recorded_by_dispatcher_id LEFT JOIN "technician" tech ON tech.id = p.recorded_by_tech_id';

export const PAYMENTS_SQL_COLUMNS: ColumnMap = {
	invoiceNumber: t("i.invoice_number"),
	clientName: t("c.name"),
	method: t("p.method"),
	note: t("p.note"),
	recordedBy: t("COALESCE(disp.name, tech.name)"),
	qbSynced: t("CASE WHEN p.qb_payment_id IS NOT NULL THEN 'Synced' ELSE 'Not synced' END"),
	amount: cur("p.amount"),
	paidAt: dt("p.paid_at"),
};

const getPaymentsSummarySql = async (
	sdb: ReturnType<typeof getScopedDb>,
	whereSql: string,
	whereParams: unknown[],
) => {
	const [totals] = await sdb.$queryRawUnsafe<{ total: number; count: number }[]>(
		`SELECT COALESCE(SUM(p.amount), 0)::float AS total, COUNT(*)::int AS count FROM ${PAYMENTS_FROM} WHERE ${whereSql}`,
		...whereParams,
	);
	const byMethodRaw = await sdb.$queryRawUnsafe<{ method: string | null; amount: number; count: number }[]>(
		`SELECT p.method AS method, COALESCE(SUM(p.amount), 0)::float AS amount, COUNT(*)::int AS count FROM ${PAYMENTS_FROM} WHERE ${whereSql} GROUP BY p.method`,
		...whereParams,
	);
	const total = totals?.total ?? 0;
	const count = totals?.count ?? 0;
	const byMethodMap = new Map<string, { amount: number; count: number }>();
	for (const g of byMethodRaw) {
		const method = g.method ? String(g.method) : "Unspecified";
		const bucket = byMethodMap.get(method) ?? { amount: 0, count: 0 };
		bucket.amount += g.amount;
		bucket.count += g.count;
		byMethodMap.set(method, bucket);
	}
	return {
		totalCollected: total,
		count,
		avg: count > 0 ? total / count : 0,
		byMethod: [...byMethodMap.entries()]
			.map(([method, b]) => ({ method, ...b }))
			.sort((a, b) => b.amount - a.amount),
	};
};

export const getPaymentsReportPage = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
	params: PaginateParams,
) => {
	const sdb = getScopedDb(organizationId);
	const df = buildDateFilter(startDate, endDate);
	const baseParams: unknown[] = [organizationId];
	let baseWhere = "i.organization_id = $1";
	if (df.gte) baseWhere += ` AND p.paid_at >= $${baseParams.push(df.gte)}`;
	if (df.lte) baseWhere += ` AND p.paid_at <= $${baseParams.push(df.lte)}`;

	const res = await runIdPrefilter({
		sdb,
		from: PAYMENTS_FROM,
		baseWhere,
		baseParams,
		idExpr: "p.id",
		columns: PAYMENTS_SQL_COLUMNS,
		defaultOrder: { expr: "p.paid_at", dir: "desc" },
		params,
		hydrate: (ids) =>
			sdb.invoice_payment.findMany({ where: { id: { in: ids } }, include: PAYMENTS_INCLUDE }),
		rowId: (r) => r.id,
	});
	if (!res) return null;
	const summary = await getPaymentsSummarySql(sdb, res.whereSql, res.whereParams);
	return {
		rows: res.rows.map(mapPaymentRaw),
		total: res.total,
		page: res.page,
		pageSize: res.pageSize,
		summary,
	};
};

// ============================================================================
// COGs (cost of goods) Report
// ============================================================================

const summarizeCostSource = (events: ConsumptionCostRow[]) => {
	const priced = events.filter((e) => e.costSource !== "no_cost_data");
	const pricedQty = round2(priced.reduce((s, e) => s + e.qtyConsumed, 0));
	const pricedTotal = round2(priced.reduce((s, e) => s + e.totalCost, 0));
	const totalCogs = priced.length === 0 ? null : pricedTotal;
	const hasNoData = events.some(e=> e.costSource === "no_cost_data");
	// "actual" is the price actually paid, so it is exact like wac, not a fallback.
	const allExact = events.every(e => e.costSource === "wac" || e.costSource === "actual");
	const costCoverage = allExact ? "Full"
		: !hasNoData ? "Estimated"
		: priced.length > 0 ? "Partial"
		: "No Cost Data";
	return { totalCogs, costCoverage, pricedQty, pricedTotal };
}

export interface CogsTrendPoint {
	month: string;
	totalCogs: number;
}

const buildCogsTrend = (events: ConsumptionCostRow[]): CogsTrendPoint[] => {
	const byMonth = new Map<string, number>();
	for (const e of events) {
		if (e.costSource === "no_cost_data") continue;
		const month = monthKey(e.consumedAt);
		byMonth.set(month, (byMonth.get(month) ?? 0) + e.totalCost);
	}
	return [...byMonth.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([month, totalCogs]) => ({ month, totalCogs: round2(totalCogs) }));
}

export const getCogsByJobReport = async (
	startDate: string | undefined,
	endDate: string | undefined, 
	orgId: string
) => {
	const { rows: events, truncated } = await computeConsumptionCosts(orgId, { 
		startDate: startDate ? new Date(startDate): undefined,
		endDate: endDate ? new Date (endDate) : undefined
	});
	
	const trend = buildCogsTrend(events);

	const byJob = new Map<string, ConsumptionCostRow[]>();
	for (const e of events) {
		(byJob.get(e.jobId) ?? byJob.set(e.jobId, []).get(e.jobId)!).push(e);
	}

	const sdb = getScopedDb(orgId);
	const jobs = await sdb.job.findMany({
		where: { id: { in: [...byJob.keys()]}},
		include: { client: { select: { name: true }}},
	});
	const rows = jobs.map((job) =>{
		const evs = byJob.get(job.id)!;
		const { totalCogs, costCoverage } = summarizeCostSource(evs);
		return {
			id: job.id,
			jobNumber: job.job_number,
			name: job.name,
			clientName: job.client.name,
			status: job.status,
			totalCogs,
			costCoverage, 
			itemCount: new Set(evs.map(e => e.inventoryItemId)).size,
			qtyConsumed: round2(evs.reduce((s, e) => s + e.qtyConsumed, 0)),
			lastConsumedAt: evs.reduce((max, e) => (e.consumedAt > max ? e.consumedAt : max), evs[0].consumedAt),
		};
	});

	return { rows, truncated, trend }
}

export const getCogsByItemReport = async (
	startDate: string | undefined,
	endDate: string | undefined, 
	orgId: string
) => {
	const { rows: events, truncated } = await computeConsumptionCosts(orgId, { 
		startDate: startDate ? new Date(startDate): undefined,
		endDate: endDate ? new Date (endDate) : undefined
	});

	const trend = buildCogsTrend(events);

	const byItem = new Map<string, ConsumptionCostRow[]>();
	for (const e of events) {
		(byItem.get(e.inventoryItemId) ?? byItem.set(e.inventoryItemId, []).get(e.inventoryItemId)!).push(e);
	}

	const sdb = getScopedDb(orgId);
	const items = await sdb.inventory_item.findMany({
		where: { id: { in: [...byItem.keys()]}},
	});
	const rows = items.map((item) =>{
		const evs = byItem.get(item.id)!;
		const { totalCogs, costCoverage, pricedQty, pricedTotal } = summarizeCostSource(evs);
		return {
			id: item.id,
			name: item.name,
			sku: item.sku,
			category: item.category,
			unit: item.unit,
			quantity: item.quantity,
			totalCogs,
			costCoverage,
			jobCount: new Set(evs.map(e => e.jobId)).size,
			qtyConsumed: round2(evs.reduce((s, e) => s + e.qtyConsumed, 0)),
			avgUnitCost: pricedQty > 0 ? round2(pricedTotal / pricedQty) : null,
			lastConsumedAt: evs.reduce((max, e) => (e.consumedAt > max ? e.consumedAt : max), evs[0].consumedAt),
		};
	});

	return { rows, truncated, trend }
}

// ============================================================================
// QUOTE CONVERSION
// ============================================================================

// The won/lost definitions the quote funnel and the paged Quotes page share.
// Both the JS aggregation and the SQL FILTER clauses below read these, so the
// two win rates can't drift for one date range (DW-24). Compile-time literals,
// safe to interpolate into the query text.
const WON_QUOTE_STATUS = "Approved" as const;
const LOST_QUOTE_STATUSES = ["Rejected", "Expired", "Cancelled"] as const;
const WON_STATUS_SQL = `'${WON_QUOTE_STATUS}'`;
const LOST_STATUS_SQL = LOST_QUOTE_STATUSES.map((s) => `'${s}'`).join(", ");

const QUOTE_INCLUDE = {
	client: { select: { name: true } },
	request: { select: { source: true } },
} satisfies Prisma.quoteInclude;

const quotesBaseWhere = (
	startDate?: string,
	endDate?: string,
): Record<string, unknown> => {
	const dateFilter = buildDateFilter(startDate, endDate);
	return {
		is_active: true,
		...(Object.keys(dateFilter).length && { created_at: dateFilter }),
	};
};

const mapQuoteRaw = (q: Prisma.quoteGetPayload<{ include: typeof QUOTE_INCLUDE }>) => {
	const approvalBaseline = q.sent_at ?? q.issued_at ?? q.created_at;
	const daysToApprove = q.approved_at
		? Math.round(((q.approved_at.getTime() - approvalBaseline.getTime()) / DAY_MS) * 10) / 10
		: null;
	return {
		quoteId: q.id,
		quoteNumber: q.quote_number,
		title: q.title,
		clientName: q.client.name,
		status: q.status,
		source: q.request?.source ?? "manual",
		total: Number(q.total),
		createdAt: q.created_at,
		issuedAt: q.issued_at,
		sentAt: q.sent_at,
		viewedAt: q.viewed_at,
		approvedAt: q.approved_at,
		daysToApprove,
	};
};

export const getQuoteFunnelReport = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
) => {
	const sdb = getScopedDb(organizationId);

	const quotes = await sdb.quote.findMany({
		where: quotesBaseWhere(startDate, endDate),
		orderBy: { created_at: "desc" },
		include: QUOTE_INCLUDE,
	});

	const funnel = { created: quotes.length, issued: 0, sent: 0, viewed: 0, approved: 0 };
	let valueWon = 0;
	let valueLost = 0;
	let wonCount = 0;
	let lostCount = 0;
	const approveDays: number[] = [];
	const bySourceMap = new Map<string, { quotes: number; approved: number }>();

	const rows = quotes.map((q) => {
		const issued = !!(q.issued_at || q.sent_at || q.viewed_at || q.approved_at);
		const sent = !!(q.sent_at || q.viewed_at || q.approved_at);
		const viewed = !!(q.viewed_at || q.approved_at);
		const approved = !!q.approved_at;
		if (issued) funnel.issued++;
		if (sent) funnel.sent++;
		if (viewed) funnel.viewed++;
		if (approved) funnel.approved++;

		const total = Number(q.total);
		if (q.status === WON_QUOTE_STATUS) {
			valueWon += total;
			wonCount++;
		}
		if ((LOST_QUOTE_STATUSES as readonly string[]).includes(q.status)) {
			valueLost += total;
			lostCount++;
		}

		const row = mapQuoteRaw(q);
		if (row.daysToApprove != null) approveDays.push(row.daysToApprove);

		const source = q.request?.source ?? "manual";
		const bucket = bySourceMap.get(source) ?? { quotes: 0, approved: 0 };
		bucket.quotes++;
		if (approved) bucket.approved++;
		bySourceMap.set(source, bucket);

		return row;
	});

	// Win rate is decided by CURRENT status so that it, valueWon and valueLost
	// all describe one population. funnel.approved is timestamp-driven and would
	// count a quote that was approved and then disputed into Cancelled on both
	// sides of the ratio; it stays timestamp-driven as a funnel STAGE count.
	const decided = wonCount + lostCount;

	return {
		funnel,
		winRate: decided > 0 ? Math.round((wonCount / decided) * 100) : null,
		avgDaysToApprove: approveDays.length
			? round2(approveDays.reduce((a, b) => a + b, 0) / approveDays.length)
			: null,
		valueWon: round2(valueWon),
		valueLost: round2(valueLost),
		bySource: [...bySourceMap.entries()].map(([source, b]) => ({
			source,
			quotes: b.quotes,
			approved: b.approved,
			rate: b.quotes > 0 ? Math.round((b.approved / b.quotes) * 100) : 0,
		})),
		quotes: rows,
	};
};

export const QUOTES_SQL_COLUMNS: ColumnMap = {
	quoteNumber: t("q.quote_number"),
	title: t("q.title"),
	clientName: t("c.name"),
	status: t("q.status::text"),
	source: t("COALESCE(r.source, 'manual')"),
	total: cur("q.total"),
	createdAt: dt("q.created_at"),
	issuedAt: dt("q.issued_at"),
	sentAt: dt("q.sent_at"),
	viewedAt: dt("q.viewed_at"),
	approvedAt: dt("q.approved_at"),
	daysToApprove: n(
		"CASE WHEN q.approved_at IS NOT NULL THEN ROUND((EXTRACT(EPOCH FROM (q.approved_at - COALESCE(q.sent_at, q.issued_at, q.created_at))) / 86400.0)::numeric, 1) ELSE NULL END",
	),
};

export const getQuoteRowsPage = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
	params: PaginateParams,
): Promise<PageResult<ReturnType<typeof mapQuoteRaw>> | null> => {
	const sdb = getScopedDb(organizationId);
	const df = buildDateFilter(startDate, endDate);
	const baseParams: unknown[] = [organizationId];
	let baseWhere = "q.organization_id = $1 AND q.is_active = true";
	if (df.gte) baseWhere += ` AND q.created_at >= $${baseParams.push(df.gte)}`;
	if (df.lte) baseWhere += ` AND q.created_at <= $${baseParams.push(df.lte)}`;

	const res = await runIdPrefilter({
		sdb,
		from: '"quote" q JOIN "client" c ON c.id = q.client_id LEFT JOIN "request" r ON r.id = q.request_id',
		baseWhere,
		baseParams,
		idExpr: "q.id",
		columns: QUOTES_SQL_COLUMNS,
		defaultOrder: { expr: "q.created_at", dir: "desc" },
		params,
		hydrate: (ids) => sdb.quote.findMany({ where: { id: { in: ids } }, include: QUOTE_INCLUDE }),
		rowId: (r) => r.id,
	});
	if (!res) return null;
	return { rows: res.rows.map(mapQuoteRaw), total: res.total, page: res.page, pageSize: res.pageSize };
};

interface FunnelScalarRow {
	created: number;
	issued: number;
	sent: number;
	viewed: number;
	approved: number;
	wonCount: number;
	valueWon: number;
	valueLost: number;
	lostCount: number;
	avgDays: number | null;
}

interface BySourceRow {
	source: string;
	quotes: number;
	approved: number;
}

export const getQuoteFunnelSummary = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
) => {
	const sdb = getScopedDb(organizationId);
	const dateFilter = buildDateFilter(startDate, endDate);

	const conds: string[] = [`q.organization_id = $1`, `q.is_active = true`];
	const params: unknown[] = [organizationId];
	if (dateFilter.gte) {
		params.push(dateFilter.gte);
		conds.push(`q.created_at >= $${params.length}`);
	}
	if (dateFilter.lte) {
		params.push(dateFilter.lte);
		conds.push(`q.created_at <= $${params.length}`);
	}
	const whereSql = conds.join(" AND ");

	const [scalar] = await sdb.$queryRawUnsafe<FunnelScalarRow[]>(
		`SELECT
			COUNT(*)::int AS created,
			COUNT(*) FILTER (WHERE q.issued_at IS NOT NULL OR q.sent_at IS NOT NULL OR q.viewed_at IS NOT NULL OR q.approved_at IS NOT NULL)::int AS issued,
			COUNT(*) FILTER (WHERE q.sent_at IS NOT NULL OR q.viewed_at IS NOT NULL OR q.approved_at IS NOT NULL)::int AS sent,
			COUNT(*) FILTER (WHERE q.viewed_at IS NOT NULL OR q.approved_at IS NOT NULL)::int AS viewed,
			COUNT(*) FILTER (WHERE q.approved_at IS NOT NULL)::int AS approved,
			COUNT(*) FILTER (WHERE q.status = ${WON_STATUS_SQL})::int AS "wonCount",
			COALESCE(SUM(q.total) FILTER (WHERE q.status = ${WON_STATUS_SQL}), 0)::float AS "valueWon",
			COALESCE(SUM(q.total) FILTER (WHERE q.status IN (${LOST_STATUS_SQL})), 0)::float AS "valueLost",
			COUNT(*) FILTER (WHERE q.status IN (${LOST_STATUS_SQL}))::int AS "lostCount",
			AVG(ROUND((EXTRACT(EPOCH FROM (q.approved_at - COALESCE(q.sent_at, q.issued_at, q.created_at))) / 86400.0)::numeric, 1)) FILTER (WHERE q.approved_at IS NOT NULL)::float AS "avgDays"
		FROM quote q
		WHERE ${whereSql}`,
		...params,
	);

	const bySourceRaw = await sdb.$queryRawUnsafe<BySourceRow[]>(
		`SELECT
			COALESCE(r.source, 'manual') AS source,
			COUNT(*)::int AS quotes,
			COUNT(*) FILTER (WHERE q.approved_at IS NOT NULL)::int AS approved
		FROM quote q
		LEFT JOIN request r ON r.id = q.request_id
		WHERE ${whereSql}
		GROUP BY COALESCE(r.source, 'manual')`,
		...params,
	);

	const funnel = {
		created: scalar?.created ?? 0,
		issued: scalar?.issued ?? 0,
		sent: scalar?.sent ?? 0,
		viewed: scalar?.viewed ?? 0,
		approved: scalar?.approved ?? 0,
	};
	// Same current-status population as getQuoteFunnelReport above.
	const wonCount = scalar?.wonCount ?? 0;
	const lostCount = scalar?.lostCount ?? 0;
	const decided = wonCount + lostCount;

	return {
		funnel,
		winRate: decided > 0 ? Math.round((wonCount / decided) * 100) : null,
		avgDaysToApprove: scalar?.avgDays != null ? round2(scalar.avgDays) : null,
		valueWon: round2(scalar?.valueWon ?? 0),
		valueLost: round2(scalar?.valueLost ?? 0),
		bySource: bySourceRaw.map((b) => ({
			source: b.source,
			quotes: b.quotes,
			approved: b.approved,
			rate: b.quotes > 0 ? Math.round((b.approved / b.quotes) * 100) : 0,
		})),
	};
};

// ============================================================================
// TECHNICIAN SCORECARD
// ============================================================================

// Visit revenue is calculated by job revenue/# techs
export const getTechnicianScorecard = async (
	startDate: string | undefined,
	endDate: string | undefined,
	organizationId: string,
) => {
	const sdb = getScopedDb(organizationId);
	const dateFilter = buildDateFilter(startDate, endDate);

	const visits = await sdb.job_visit.findMany({
		where: {
			status: "Completed",
			job: { organization_id: organizationId },
			...(Object.keys(dateFilter).length && { scheduled_start_at: dateFilter }),
		},
		orderBy: { scheduled_start_at: "desc" },
		include: {
			job: {
				select: {
					id: true,
					name: true,
					client: { select: { name: true } },
				},
			},
			visit_techs: { select: { tech: { select: { id: true, name: true } } } },
			time_entries: { select: { tech_id: true, hours_worked: true } },
		},
	});

	const rows: {
		techId: string;
		techName: string;
		visitId: string;
		jobId: string;
		jobName: string;
		clientName: string;
		scheduledStartAt: Date;
		actualStartAt: Date | null;
		arrival: "Early" | "On Time" | "Late" | null;
		hoursWorked: number;
		revenueShare: number;
	}[] = [];

	for (const visit of visits) {
		const techs = visit.visit_techs;
		if (!techs.length) continue;
		const revenueShare = round2(Number(visit.total) / techs.length);
		const arrival = classifyArrival(visit.scheduled_start_at, visit.actual_start_at);

		for (const { tech } of techs) {
			const hoursWorked = visit.time_entries
				.filter((e) => e.tech_id === tech.id)
				.reduce((s, e) => s + Number(e.hours_worked ?? 0), 0);

			rows.push({
				techId: tech.id,
				techName: tech.name,
				visitId: visit.id,
				jobId: visit.job.id,
				jobName: visit.job.name,
				clientName: visit.job.client.name,
				scheduledStartAt: visit.scheduled_start_at,
				actualStartAt: visit.actual_start_at,
				arrival,
				hoursWorked: round2(hoursWorked),
				revenueShare,
			});
		}
	}

	return rows;
};

// ===========================================================================================
// Job Profitability
// ===========================================================================================

const JOB_BILLING_SELECT = {
	job_number: true,
	name: true,
	client: { select: { name: true } },
} as const;

// Coverage for a job that consumed nothing — distinct from "No Cost Data",
// which means material was consumed and could not be priced.
export const NO_MATERIALS = "No Materials";

// Share of an invoice's pre-discount subtotal that survives the discount.
// Clamped to [0,1]: a discount over subtotal would otherwise flip revenue negative.
export const discountNetFactor = (subtotal: unknown, discountAmount: unknown) => {
	const base = Number(subtotal ?? 0);
	const discount = Number(discountAmount ?? 0);
	if (!(base > 0) || !(discount > 0)) return 1;
	return Math.max(0, 1 - discount / base);
};


export const getJobProfitabilityReport = async (
	startDate: string | undefined,
	endDate: string | undefined,
	orgId: string,
) => {
	const sdb = getScopedDb(orgId);
	const dateFilter = buildDateFilter(startDate, endDate);

	const jobCogs = await getCogsByJobReport(undefined, undefined, orgId);
	const directCosts = await computeJobDirectCosts(orgId);
	// The only org-config read in this file. Decimal columns, so Number() by hand —
	// num() returns 0 for a Decimal and would price every mile and hour at nothing.
	const orgCfg = await sdb.organization.findFirst({
		where: { id: orgId },
		select: { cost_per_mile: true, monthly_overhead: true, overhead_rate_per_hour: true },
	});
	const perMile = Number(orgCfg?.cost_per_mile ?? 0);
	const overheadRate =
		orgCfg?.overhead_rate_per_hour == null ? null : Number(orgCfg.overhead_rate_per_hour);
	const invoices = await sdb.invoice.findMany({
		where: {
			status: { notIn: ["Draft", "Void"] },
			...(Object.keys(dateFilter).length && {
				OR: [{ issue_date: dateFilter }, { issue_date: null, created_at: dateFilter }],
			}),
		},
		// Unordered, the cap returns an arbitrary set and the same query can report
		// different revenue twice. Newest first, so a truncated run drops the
		// oldest invoices; id breaks ties, which issue_date alone does not.
		orderBy: [
			{ issue_date: { sort: "desc", nulls: "last" } },
			{ created_at: "desc" },
			{ id: "asc" },
		],
		take: REPORT_ROW_CAP,
		include: {
			jobs: {
				include: {
					job: { select: JOB_BILLING_SELECT },
				},
			},
			visits: {
				include: {
					visit: {
						select: {
							job_id: true,
							job: { select: JOB_BILLING_SELECT },
						},
					},
				},
			},
		},
	});

	// Gross margin 
	const cogsByJob = new Map(jobCogs.rows.map((r) => [String(r.id), r]));

	type BilledJobMeta = (typeof invoices)[number]["jobs"][number]["job"];
	const jobRevenue = new Map<string, { revenue: number; job: BilledJobMeta }>();
	const addRevenue = (jobId: string, amount: number, job: BilledJobMeta) => {
		const prev = jobRevenue.get(jobId);
		jobRevenue.set(jobId, {
			revenue: (prev?.revenue ?? 0) + amount,
			job: prev?.job ?? job,
		});
	};

	for (const i of invoices) {
		// billed_amount sums line items, which never carry the invoice-level
		// discount — scale it down or the discount lands in gross profit.
		const net = discountNetFactor(i.subtotal, i.discount_amount);
		for (const j of i.jobs) addRevenue(j.job_id, Number(j.billed_amount ?? 0) * net, j.job);
		for (const v of i.visits)
			addRevenue(v.visit.job_id, Number(v.billed_amount ?? 0) * net, v.visit.job);
	}

	// Costs are job-lifetime, so a windowed view takes the share of them matching
	// the share of lifetime revenue billed in the window.
	const lifetimeRevenue = new Map<string, number>();
	if (Object.keys(dateFilter).length && jobRevenue.size) {
		const jobIds = [...jobRevenue.keys()];
		const allInvoices = await sdb.invoice.findMany({
			where: {
				status: { notIn: ["Draft", "Void"] },
				OR: [
					{ jobs: { some: { job_id: { in: jobIds } } } },
					{ visits: { some: { visit: { job_id: { in: jobIds } } } } },
				],
			},
			select: {
				subtotal: true,
				discount_amount: true,
				jobs: { select: { job_id: true, billed_amount: true } },
				visits: { select: { billed_amount: true, visit: { select: { job_id: true } } } },
			},
		});
		const addLifetime = (jobId: string, amount: number) =>
			lifetimeRevenue.set(jobId, (lifetimeRevenue.get(jobId) ?? 0) + amount);
		for (const i of allInvoices) {
			const net = discountNetFactor(i.subtotal, i.discount_amount);
			for (const j of i.jobs) addLifetime(j.job_id, Number(j.billed_amount ?? 0) * net);
			for (const v of i.visits) addLifetime(v.visit.job_id, Number(v.billed_amount ?? 0) * net);
		}
	}

	// Net margin
	const directByJob = new Map(directCosts.map((d) => [d.jobId, d]));

	const rows = [...jobRevenue.entries()]
		.map(([jobId, { revenue, job }]) => {
			const lifetime = lifetimeRevenue.get(jobId) ?? 0;
			const share = lifetime > 0 ? Math.min(1, revenue / lifetime) : 1;

			// A null totalCogs means events exist but none could be priced — unknown.
			// No events at all means nothing was consumed, which is a real 0.
			const cogRow = cogsByJob.get(jobId);
			const cogs = cogRow && cogRow.totalCogs == null ? "-" : round2(Number(cogRow?.totalCogs ?? 0) * share);
			const profit = cogs === "-" ? "-" : round2(revenue - cogs);
			const margin = revenue > 0 && profit !== "-" ? round2((profit / revenue) * 100) : null;

			const direct = directByJob.get(jobId);
			const hours = (direct?.hours ?? 0) * share;
			// Partial rating dashes too: one unrated tech on a two-tech job yields an
			// understated figure that reads as exact, which is worse than admitting it.
			const laborCost = direct && direct.unratedHours > 0 ? "-" : round2((direct?.laborCost ?? 0) * share);
			// Zero miles on a visited job is likely an unrecorded drive, but dashing it
			// blanked Net on most rows for the smallest cost — price it at 0 and flag it.
			const travelMissing = perMile > 0 && (direct?.visitCount ?? 0) > 0 && (direct?.miles ?? 0) === 0;
			const travelCost = round2((direct?.miles ?? 0) * perMile * share);
			// No rate set is unknown overhead, not free overhead — unless no hours were
			// worked, where zero is the honest answer either way.
			const overheadCost =
				overheadRate == null ? (hours > 0 ? "-" : 0) : round2(hours * overheadRate);

			const netKnown = cogs !== "-" && laborCost !== "-" && overheadCost !== "-";
			const netProfit = netKnown
				? round2(revenue - cogs - laborCost - travelCost - overheadCost)
				: "-";
			const netMargin =
				revenue > 0 && netProfit !== "-" ? round2((netProfit / revenue) * 100) : null;

			return {
				jobId,
				jobNumber: job.job_number,
				jobName: job.name,
				clientName: job.client?.name ?? null,
				revenue: round2(revenue),
				cogs,
				// Anything but Full means the COGS beside it is soft, so profit is too.
				costCoverage: cogRow?.costCoverage ?? NO_MATERIALS,
				// profit/margin stay GROSS: the Gross view and its tile mean gross, and
				// the net figures ride alongside as their own keys.
				profit,
				margin,
				laborHours: round2(hours),
				laborCost,
				travelCost,
				_travelMissing: travelMissing,
				overheadCost,
				netProfit,
				netMargin,
			};
		})
		.sort((a, b) => b.revenue - a.revenue);

	// Absorption variance is org-wide and window-scoped, so it cannot be derived
	// from the rows: it needs hours from jobs with no invoiced revenue in the
	// window too. groupBy/aggregate is the right tool here — getScopedDb hooks it
	// and applies the two-hop visit->job->org filter for free.
	const windowHours = Number(
		(
			await sdb.visit_tech_time_entry.aggregate({
				_sum: { hours_worked: true },
				...(Object.keys(dateFilter).length && { where: { clocked_in_at: dateFilter } }),
			})
		)._sum.hours_worked ?? 0,
	);
	const overheadAbsorbed = overheadRate == null ? null : round2(windowHours * overheadRate);
	// A monthly pool spread over "all time" means nothing, so no window means no
	// variance — a null beats a confident wrong number.
	// shortcut: a partial month counts as a whole one, so the pool overstates on
	// ragged ranges; upgrade to day-proration if anyone reads it closely.
	// UTC, not local: getMonth() on "2026-03-01T00:00:00Z" reads February west of
	// Greenwich, which silently doubles the pool on a single-month range.
	const monthsSpanned =
		startDate && endDate
			? (new Date(endDate).getUTCFullYear() - new Date(startDate).getUTCFullYear()) * 12 +
				(new Date(endDate).getUTCMonth() - new Date(startDate).getUTCMonth()) +
				1
			: null;
	const overheadPool =
		monthsSpanned == null ? null : round2(Number(orgCfg?.monthly_overhead ?? 0) * monthsSpanned);
	const absorptionVariance =
		overheadPool == null || overheadAbsorbed == null ? null : round2(overheadPool - overheadAbsorbed);

	// Three independent caps can each make these figures incomplete, and all three
	// warrant the same warning: consumption events (understates COGS -> overstates
	// profit), invoices scanned (understates revenue), and report rows (drops jobs).
	const rowsTruncated = rows.length > REPORT_ROW_CAP;
	const truncated = rowsTruncated || jobCogs.truncated || invoices.length >= REPORT_ROW_CAP;
	return {
		rows: rowsTruncated ? rows.slice(0, REPORT_ROW_CAP) : rows,
		truncated,
		overheadPool,
		overheadAbsorbed,
		absorptionVariance,
		overheadRateSet: overheadRate != null,
	};
}

// =========================================================================================================
// Page Summary
// =========================================================================================================

export const PAGES = ["jobs", "quotes", "requests", "invoices", "clients", "inventory", "projects"] as const;
export type SummaryPage = (typeof PAGES)[number];
export const BREAKDOWNS: Record<SummaryPage, string[]> = {
	jobs: ["status", "priority", "type"],
	quotes: ["status", "priority"],
	requests: ["status", "priority"],
	invoices: ["status", "qb_sync"],
	clients: ["status", "tax_exempt"],
	inventory: ["status", "qb_linked"],
	projects: ["status", "priority", "manager"],
};
type Stat = { label: string; value: number; format: "number" | "currency" | "percent" | "duration"; note?: string };
type Slice = { label: string; value: number; };
interface PageSummaryResponse {
	page: string;
	stats: Stat[];
	breakdown: Slice[];
	breakdownLabel: string;
}

// Draft invoices are not issued yet and Void ones are cancelled (voiding only stamps
// voided_at — total/balance_due keep their values), so the money figures below leave
// both out, matching the invoices, revenue and aged-receivables reports.
const ISSUED_INVOICE_STATUS = { notIn: ["Draft", "Void"] } satisfies Prisma.invoiceWhereInput["status"];

// Disputed invoices are still owed, so they stay in the receivables total,
// but ageing them alongside uncontested debt misstates collection risk.
// They are reported separately instead.
const AGING_INVOICE_STATUS = {
	notIn: [...AR_EXCLUDED_STATUSES],
} satisfies Prisma.invoiceWhereInput["status"];
const DISPUTED_INVOICE_STATUS = { equals: "Disputed" } satisfies Prisma.invoiceWhereInput["status"];

export const isSummaryPage = (page: string): page is SummaryPage =>
	(PAGES as readonly string[]).includes(page);

export const getPageSummary = async (orgId: string, page:string, startDate?: string, endDate?: string, groupBy?: string): Promise<PageSummaryResponse> => {
	if (!isSummaryPage(page))
		throw httpError(400, ErrorCodes.VALIDATION_ERROR, `Unknown page: ${page}`);
	const allowed = BREAKDOWNS[page] ?? ["status"];
	const grouping = groupBy && allowed.includes(groupBy) ? groupBy : allowed[0];
	const sdb = getScopedDb(orgId);
	const dateFilter = buildDateFilter(startDate, endDate);
	const dated = Object.keys(dateFilter).length ? dateFilter : undefined;
	const createdWhere = dated? { created_at: dated } : {}
	const now = new Date();
	let stats: Stat[] = [];
	let breakdown: Slice[] = [];
	let breakdownLabel = "";
	
	switch (page) {
		case "jobs": {
			const OPEN_STATUSES = ["Unscheduled", "Scheduled", "InProgress"] as const;
			const [total, open, backlog, revenue] = await Promise.all([
				sdb.job.count({ where: { organization_id: orgId, ...createdWhere }}),
				sdb.job.count({ where: { organization_id: orgId, status: { in: [...OPEN_STATUSES] }, ...createdWhere }}),
				sdb.job.aggregate({
					where: { organization_id: orgId, status: "Unscheduled", ...createdWhere },
					_sum: { estimated_total: true },
				}),
				sdb.job_visit.aggregate({
					// Revenue is scoped by completion date, not job creation.
					where: { status: "Completed", ...(dated ? { actual_end_at: dated } : {}) },
					_sum: { total: true },
				}),
			]);
			if (grouping === "priority") {
				const g = await sdb.job.groupBy({ by: ["priority"], where: { organization_id: orgId, ...createdWhere }, _count: { _all: true } });
				breakdown = g.map((r) => ({ label: r.priority, value: r._count._all }));
				breakdownLabel = "By Priority";
			} else if (grouping === "type") {
				const [oneOff, recurring] = await Promise.all([
					sdb.job.count({ where: { organization_id: orgId, recurring_plan_id: null, ...createdWhere } }),
					sdb.job.count({ where: { organization_id: orgId, recurring_plan_id: { not: null }, ...createdWhere } }),
				]);
				breakdown = [
					{ label: "One-off", value: oneOff },
					{ label: "Recurring", value: recurring },
				];
				breakdownLabel = "By Type";
			} else {
				const g = await sdb.job.groupBy({ by: ["status"], where: { organization_id: orgId, ...createdWhere }, _count: { _all: true } });
				breakdown = g.map((r) => ({ label: r.status, value: r._count._all }));
				breakdownLabel = "By Status";
			}
			stats = [
				{ label: "Total",         value: total,                                        format: "number" },
				{ label: "Open",          value: open,                                         format: "number" },
				{ label: "Unscheduled",   value: Number(backlog._sum.estimated_total ?? 0),    format: "currency" },
				{ label: "Revenue",       value: Number(revenue._sum.total ?? 0),              format: "currency" },
			];
			break;
		}
		case "quotes": {
			const createdRangeSql = Prisma.sql`
				${dated?.gte ? Prisma.sql`AND created_at >= ${dated.gte}` : Prisma.empty}
				${dated?.lte ? Prisma.sql`AND created_at <= ${dated.lte}` : Prisma.empty}`;
			const [total, open, pipeline, approved, rows] = await Promise.all([
				sdb.quote.count({ where: { organization_id: orgId, ...createdWhere }}),
				sdb.quote.count({ where: { organization_id: orgId, status: { in: [...QUOTE_OPEN_STATUSES]}, ...createdWhere }}),
				sdb.quote.aggregate({
					where: { organization_id: orgId, status: { in: [...QUOTE_OPEN_STATUSES]}, ...createdWhere },
					_sum: { total: true }
				}),
				sdb.quote.aggregate({ 
					where: { organization_id: orgId, status: "Approved", ...createdWhere},
					_sum: { total: true },
				}),
				sdb.$queryRaw<{ avg_seconds: number | null }[]>(Prisma.sql`
					SELECT EXTRACT(EPOCH FROM AVG(approved_at - sent_at)) AS avg_seconds
					FROM quote
					WHERE organization_id = ${orgId}
						AND approved_at IS NOT NULL
						AND sent_at IS NOT NULL
						${createdRangeSql}`),
			]);
			const avgSeconds = rows[0]?.avg_seconds ?? null;
			const avgDays = avgSeconds != null ? avgSeconds / 86_400 : null;
			if (grouping === "priority") {
				const g = await sdb.quote.groupBy({ by: ["priority"], where: { organization_id: orgId, ...createdWhere }, _count: { _all: true } });
				breakdown = g.map((r) => ({ label: r.priority, value: r._count._all }));
				breakdownLabel = "By Priority";
			} else {
				const g = await sdb.quote.groupBy({ by: ["status"], where: { organization_id: orgId, ...createdWhere }, _count: { _all: true } });
				breakdown = g.map((r) => ({ label: r.status, value: r._count._all }));
				breakdownLabel = "By Status";
			}
			stats = [
				{ label: "Total",    	 	  value: total,                            format: "number" },
				{ label: "Open",     	 	  value: open,                             format: "number" },
				{ label: "Pipeline", 	 	  value: Number(pipeline._sum.total ?? 0), format: "currency" },
				{ label: "Approved", 	 	  value: Number(approved._sum.total ?? 0), format: "currency" },
				{ label: "Avg. Approve Time", value: Number(avgDays), 	  		  	   format: "duration"}
			];
			break;
		} 
		case "requests": {
			const OPEN_STATUSES = ["New", "Reviewing"] as const;
			const [total, open, converted, estimatedValue] = await Promise.all([
				sdb.request.count({ where: { organization_id: orgId, ...createdWhere }}),
				sdb.request.count({ where: { organization_id: orgId, status: { in: [...OPEN_STATUSES]}, ...createdWhere}}),
				sdb.request.count({ where: { organization_id: orgId, status: "ConvertedToJob", ...createdWhere }}),
				sdb.request.aggregate({
					where: { organization_id: orgId, ...createdWhere },
					_sum: { estimated_value: true }
				})
			]);
			if (grouping === "priority") {
				const g = await sdb.request.groupBy({ by: ["priority"], where: { organization_id: orgId, ...createdWhere }, _count: { _all: true } });
				breakdown = g.map((r) => ({ label: r.priority, value: r._count._all }));
				breakdownLabel = "By Priority";
			} else {
				const g = await sdb.request.groupBy({ by: ["status"], where: { organization_id: orgId, ...createdWhere }, _count: { _all: true } });
				breakdown = g.map((r) => ({ label: r.status, value: r._count._all }));
				breakdownLabel = "By Status";
			}
			stats = [
				{ label: "Total",      value: total,                                        format: "number" },
				{ label: "Open",       value: open,                                         format: "number" },
				{ label: "Converted",  value: converted,                                    format: "number" },
				{ label: "Est. Value", value: Number(estimatedValue._sum.estimated_value ?? 0),   format: "currency" },
			];
			break;
		} 
		case "invoices": {
			const invoiceDateWhere: Prisma.invoiceWhereInput = dated
				? { OR: [{ issue_date: dated }, { issue_date: null, created_at: dated }] }
				: {};
			const issueRangeSql = Prisma.sql`
				${dated?.gte ? Prisma.sql`AND issue_date >= ${dated.gte}` : Prisma.empty}
				${dated?.lte ? Prisma.sql`AND issue_date <= ${dated.lte}` : Prisma.empty}`;
			const [total, issued, collected, rows] = await Promise.all([
				sdb.invoice.count({
					where: { organization_id: orgId, status: ISSUED_INVOICE_STATUS, ...invoiceDateWhere },
				}),
				sdb.invoice.aggregate({
					where: { organization_id: orgId, status: ISSUED_INVOICE_STATUS, ...invoiceDateWhere },
					_sum: { total: true },
				}),
				// Collected = payments recorded in the range, partials included — the same
				// definition as the Payments report. invoice.paid_at/amount_paid only move
				// once an invoice is fully paid, so they drop partial payments and date the
				// rest by the final one.
				sdb.invoice_payment.aggregate({
					where: {
						invoice: { organization_id: orgId, status: ISSUED_INVOICE_STATUS },
						...(dated ? { paid_at: dated } : {}),
					},
					_sum: { amount: true },
				}),
				sdb.$queryRaw<{ avg_seconds: number | null }[]>(Prisma.sql`
					SELECT EXTRACT(EPOCH FROM AVG(paid_at - issue_date)) AS avg_seconds
					FROM invoice
					WHERE organization_id = ${orgId}
						AND paid_at IS NOT NULL
						AND issue_date IS NOT NULL
						${issueRangeSql}`),
			]);
			const avgSeconds = rows[0]?.avg_seconds ?? null;
			const avgDays = avgSeconds != null ? avgSeconds / 86_400 : null;
			// The breakdowns deliberately keep every status: each slice drills into the
			// Invoices list filtered by that status, and that list shows Draft and Void
			// rows, so the slice counts must match what the user lands on.
			if (grouping === "qb_sync") {
				const g = await sdb.invoice.groupBy({ by: ["qb_sync_status"], where: { organization_id: orgId, ...invoiceDateWhere }, _count: { _all: true } });
				breakdown = g.map((r) => ({ label: r.qb_sync_status, value: r._count._all }));
				breakdownLabel = "By QB Sync";
			} else {
				const g = await sdb.invoice.groupBy({ by: ["status"], where: { organization_id: orgId, ...invoiceDateWhere }, _count: { _all: true } });
				breakdown = g.map((r) => ({ label: r.status, value: r._count._all }));
				breakdownLabel = "By Status";
			}
			stats = [
				{ label: "Total",           value: total,                                    format: "number" },
				{ label: "Created",         value: Number(issued._sum.total ?? 0),           format: "currency" },
				{ label: "Collected",       value: Number(collected._sum.amount ?? 0),       format: "currency" },
				{ label: "Avg. Days to Pay", value: Number(avgDays),                          format: "duration" },
			];
			break;
		}
		case "clients": {
			const [total, added, active, agingBalance, disputedBalance, income] = await Promise.all([
				sdb.client.count({ where: { organization_id: orgId } }),
				sdb.client.count({ where: { organization_id: orgId, ...createdWhere } }),
				sdb.client.count({ where: { organization_id: orgId, is_active: true } }),
				// Mirrors aged receivables: only issued, unpaid invoices carry a real balance.
				sdb.invoice.aggregate({
					where: {
						organization_id: orgId,
						status: AGING_INVOICE_STATUS,
						// not: 0, so an unapplied credit nets against the
						// client's open balance instead of being invisible.
						balance_due: { not: 0 },
					},
					_sum: { balance_due: true },
				}),
				// Disputed invoices are still owed, so they stay in the receivables
				// total (see AGING_INVOICE_STATUS above) — added back in below.
				sdb.invoice.aggregate({
					where: {
						organization_id: orgId,
						status: DISPUTED_INVOICE_STATUS,
						// not: 0, so an unapplied credit nets against the
						// client's open balance instead of being invisible.
						balance_due: { not: 0 },
					},
					_sum: { balance_due: true },
				}),
				sdb.invoice.aggregate({
					where: { organization_id: orgId, status: ISSUED_INVOICE_STATUS },
					_sum: { total: true },
				}),
			]);
			const openBalance =
				Number(agingBalance._sum.balance_due ?? 0) + Number(disputedBalance._sum.balance_due ?? 0);
			// Avg income per client = total billed spread over the whole client book
			const avgIncome = total > 0 ? Number(income._sum.total ?? 0) / total : 0;
			if (grouping === "tax_exempt") {
				const g = await sdb.client.groupBy({ by: ["is_tax_exempt"], where: { organization_id: orgId }, _count: { _all: true } });
				breakdown = g.map((r) => ({ label: r.is_tax_exempt ? "Exempt" : "Taxable", value: r._count._all }));
				breakdownLabel = "By Tax Status";
			} else {
				const g = await sdb.client.groupBy({ by: ["is_active"], where: { organization_id: orgId }, _count: { _all: true } });
				breakdown = g.map((r) => ({ label: r.is_active ? "Active" : "Inactive", value: r._count._all }));
				breakdownLabel = "By Status";
			}
			stats = [
				{ label: "Total",        value: total,                                     format: "number" },
				{ label: "New",          value: added,                                     format: "number" },
				{ label: "Active",       value: active,                                    format: "number" },
				{ label: "Open Balance", value: openBalance,                                     format: "currency" },
				{ label: "Avg. Income",   value: avgIncome,                                 format: "currency" },
			];
			break;
		}
		case "inventory": {
			const itemWhere = { organization_id: orgId, provisional: false, is_active: true };
			// Total comes from count(): the row list below is capped, so its length
			// would silently understate a large catalog.
			// Asset value counts warehouse + fleet stock and discontinued items, like
			// the inventory report; only stock status is limited to active items.
			const [items, itemCount, [asset]] = await Promise.all([
				sdb.inventory_item.findMany({
					where: itemWhere,
					select: { id: true, quantity: true, low_stock_threshold: true },
					take: REPORT_ROW_CAP,
				}),
				sdb.inventory_item.count({ where: itemWhere }),
				sdb.$queryRaw<{ value: number; missingCost: number }[]>(Prisma.sql`
					SELECT
						COALESCE(SUM(ii.cost * (ii.quantity + ${Prisma.raw(FLEET_ON_HAND)})), 0)::float AS "value",
						COUNT(*) FILTER (WHERE ii.cost IS NULL AND ii.quantity + ${Prisma.raw(FLEET_ON_HAND)} > 0)::int AS "missingCost"
					FROM "inventory_item" ii
					WHERE ii.organization_id = ${orgId} AND ii.provisional = false
				`),
			]);
			let low = 0;
			let out = 0;
			let sufficient = 0;
			for (const it of items) {
				const status = getStockStatus(it.quantity, it.low_stock_threshold);
				if (status === "low") low++;
				else if (status === "out_of_stock") out++;
				else if (status === "sufficient") sufficient++;
			}
			if (grouping === "qb_linked") {
				const realmId = await getOrgRealmId(orgId);
				const mappings = realmId
					? await sdb.item_external_mapping.findMany({
							where: {
								provider: "quickbooks",
								account_id: realmId,
								inventory_item_id: { in: items.map((it) => it.id) },
							},
							select: { inventory_item_id: true },
						})
					: [];
				const linkedIds = new Set(mappings.map((m) => m.inventory_item_id));
				const linked = items.filter((it) => linkedIds.has(it.id)).length;
				breakdown = [
					{ label: "Linked", value: linked },
					{ label: "Not Linked", value: items.length - linked },
				];
				breakdownLabel = "By QuickBooks";
			} else {
				breakdown = [
					{ label: "Sufficient", value: sufficient },
					{ label: "Low", value: low },
					{ label: "Out of Stock", value: out },
				];
				breakdownLabel = "By Stock Status";
			}
			stats = [
				{ label: "Total Items",  value: itemCount,    format: "number" },
				{ label: "Low",          value: low,          format: "number" },
				{ label: "Out of Stock", value: out,          format: "number" },
				{
					label: "Asset Value",
					value: asset?.value ?? 0,
					format: "currency",
					...(asset?.missingCost && {
						note: `${asset.missingCost} item${asset.missingCost === 1 ? "" : "s"} without cost`,
					}),
				},
			];
			break;
		}
		case "projects": {
			const OPEN_STATUSES = ["Planning", "Active", "OnHold"] as const;
			const [total, open, overdue, budget, committed] = await Promise.all([
				sdb.project.count({ where: { organization_id: orgId, ...createdWhere } }),
				sdb.project.count({ where: { organization_id: orgId, status: { in: [...OPEN_STATUSES] }, ...createdWhere } }),
				sdb.project.count({
					where: {
						organization_id: orgId,
						target_end_at: { lt: now },
						completed_at: null,
						status: { notIn: ["Completed", "Cancelled"] },
					},
				}),
				sdb.project.aggregate({ where: { organization_id: orgId, ...createdWhere }, _sum: { budget: true } }),
				sdb.$queryRaw<{ committed: Prisma.Decimal | null }[]>(Prisma.sql`
						SELECT SUM(COALESCE(j.actual_total, j.estimated_total)) AS committed
						FROM job j JOIN project p ON p.id = j.project_id
						WHERE p.organization_id = ${orgId}
							${dated?.gte ? Prisma.sql`AND p.created_at >= ${dated.gte}` : Prisma.empty}
							${dated?.lte ? Prisma.sql`AND p.created_at <= ${dated.lte}` : Prisma.empty}
					`),
			]);
			if (grouping === "priority") {
				const g = await sdb.project.groupBy({ by: ["priority"], where: { organization_id: orgId, ...createdWhere }, _count: { _all: true } });
				breakdown = g.map((r) => ({ label: r.priority, value: r._count._all }));
				breakdownLabel = "By Priority";
			} else if (grouping === "manager") {
				const g = await sdb.project.groupBy({
					by: ["manager_dispatcher_id"],
					where: { organization_id: orgId, ...createdWhere },
					_count: { _all: true },
				});
				const ids = g.map((r) => r.manager_dispatcher_id).filter((v): v is string => v !== null);
				const names = new Map(
					(await sdb.dispatcher.findMany({
						where: { id: { in: ids } },
						select: { id: true, name: true },
					})).map((d) => [d.id, d.name]),
				);
				const all = g
					.map((r) => ({
						label: r.manager_dispatcher_id
							? names.get(r.manager_dispatcher_id) ?? "Unknown"
							: "Unassigned",
						value: r._count._all,
					}))
					.sort((a, b) => b.value - a.value);
				const top = all.slice(0, 5);
				const rest = all.slice(5).reduce((s, r) => s + r.value, 0);
				breakdown = rest ? [...top, { label: "Other", value: rest }] : top;
				breakdownLabel = "By Manager";
			} else {
				const g = await sdb.project.groupBy({ by: ["status"], where: { organization_id: orgId, ...createdWhere }, _count: { _all: true } });
				breakdown = g.map((r) => ({ label: r.status, value: r._count._all }));
				breakdownLabel = "By Status";
			}
			stats = [
				{ label: "Total",			value: total,                                						 format: "number" },
				{ label: "Open",			value: open,                                 						format: "number" },
				{ label: "Overdue",		 value: overdue,                              						format: "number" },
				{ label: "Budget",		   value: Number(budget._sum.budget ?? 0),      	format: "currency" },
				{ label: "Committed", 	value: Number(committed[0]?.committed ?? 0), format: "currency" },
			];
			break;
		}
	}

	return { page, stats, breakdown, breakdownLabel };
}