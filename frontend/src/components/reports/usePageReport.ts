import { useMemo, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { usePageSnapshotQuery, usePageSummaryQuery } from "../../hooks/useReports";
import { useQBStatusQuery } from "../../hooks/useQuickbooks";
import { usePermission } from "../../hooks/usePermission";
import { readCachedEntitlements, useEntitlements } from "../../hooks/useEntitlements";
import { moduleState } from "../../lib/permissionAccess";
import type { PageSnapshotResponse, PageSummaryResponse } from "../../types/reports";
import type { DateRangeOption, DateRangeValue } from "../../util/dateRangeUtils";
import { resolveDateRange, serializeDateRange } from "../../util/dateRangeUtils";

export type ReportPage =
	| "jobs"
	| "quotes"
	| "requests"
	| "invoices"
	| "clients"
	| "inventory"
	| "projects"
	| "recurring_plans";

const PAST_PRESETS: DateRangeOption[] = ["all", "today", "last_7_days", "last_30_days", "this_month", "custom"];
// Plans are ranged by when they're in effect, so the future means something too.
const PLAN_PRESETS: DateRangeOption[] = [
	"all",
	"today",
	"last_7_days",
	"last_30_days",
	"this_month",
	"next_7_days",
	"next_30_days",
	"next_month",
	"custom",
];

// Every inventory stat is current stock, so a date range would change nothing.
const UNRANGED_PAGES: ReportPage[] = ["inventory"];

const BREAKDOWNS: Record<ReportPage, string[]> = {
	jobs: ["status", "priority", "type"],
	quotes: ["status", "priority"],
	requests: ["status", "priority"],
	invoices: ["status", "qb_sync"],
	clients: ["status", "tax_exempt"],
	inventory: ["status", "qb_linked"],
	projects: ["status", "priority", "manager"],
	recurring_plans: ["status", "priority"],
};

export const DIMENSION_LABELS: Record<string, string> = {
	status: "Status",
	priority: "Priority",
	type: "Type",
	qb_sync: "QB Sync",
	qb_linked: "QuickBooks",
	tax_exempt: "Tax Status",
	manager: "Manager",
};

// Mirrors the backend's PAGE_SUMMARY_MODULE: these summaries 403 without the module.
const PAGE_MODULE: Partial<Record<ReportPage, string>> = {
	quotes: "quotes",
	inventory: "inventory",
	projects: "projects",
	recurring_plans: "recurring_plans",
};

// A donut is for a small fixed set of parts of a whole. Status/priority/manager
// are ordinal or open-ended, so they stay bars however few groups today's data has.
const DONUT_DIMS = ["type", "tax_exempt", "qb_sync", "qb_linked"];
const DONUT_STATUS_PAGES: ReportPage[] = ["inventory", "clients"];

const STATUS_DRILL: ReportPage[] = [
	"jobs",
	"quotes",
	"requests",
	"invoices",
	"clients",
	"inventory",
	"projects",
	"recurring_plans",
];
// The inventory breakdown prints stock-status labels; its list filters on the stored value.
const INVENTORY_STOCK_VALUES: Record<string, string> = {
	Sufficient: "sufficient",
	Low: "low",
	"Out of Stock": "out_of_stock",
};
const PRIORITY_DRILL: ReportPage[] = ["jobs", "quotes", "requests", "projects"];
// The summary counts jobs by CREATED date but the Jobs list filters by
// SCHEDULED date, so carrying the range there would land on a different
// set than the bar shows. Plans are ranged server-side by when they're in
// effect, exactly what the Plans list's Date filter matches.
const CARRIES_DATE: ReportPage[] = ["quotes", "requests", "invoices", "projects", "recurring_plans"];

export function getReportHref(
	page: ReportPage,
	groupBy: string,
	label: string,
	range: DateRangeValue,
): string | null {
	let params: URLSearchParams;
	if (groupBy === "status" && STATUS_DRILL.includes(page)) {
		let value: string | null = label;
		if (page === "clients") {
			value = label === "Active" ? "active" : label === "Inactive" ? "inactive" : null;
		} else if (page === "inventory") {
			value = INVENTORY_STOCK_VALUES[label] ?? null;
		}
		if (!value) return null;
		params = new URLSearchParams({ [page === "inventory" ? "stock" : "status"]: value });
	} else if (groupBy === "priority" && PRIORITY_DRILL.includes(page)) {
		params = new URLSearchParams({ priority: label });
	} else if (groupBy === "tax_exempt" && page === "clients") {
		params = new URLSearchParams({ tax: label === "Exempt" ? "exempt" : "taxable" });
	} else {
		return null;
	}
	if (CARRIES_DATE.includes(page)) params = serializeDateRange(range, "date", params);
	if (page === "recurring_plans") return `/dispatch/jobs?view=templates&${params.toString()}`;
	return `/dispatch/${page}?${params.toString()}`;
}

export interface PageReportState {
	page: ReportPage;
	label: string;
	canView: boolean;
	open: boolean;
	setOpen: (open: boolean) => void;
	range: DateRangeValue;
	setRange: (range: DateRangeValue) => void;
	options: string[];
	groupBy: string;
	setGroupBy: (groupBy: string) => void;
	query: UseQueryResult<PageSummaryResponse, Error>;
	snapshot: UseQueryResult<PageSnapshotResponse, Error>;
	ranged: boolean;
	hrefFor: (label: string) => string | null;
	canDrill: boolean;
	presets: DateRangeOption[];
	chart: "donut" | "bar";
}

export function usePageReport(
	page: ReportPage,
	label: string,
	{ allowed = true }: { allowed?: boolean } = {},
): PageReportState {
	const hasPermission = usePermission("view_reports");
	// Same rule as moduleQuery: hold while entitlements are unknown, and only
	// not_in_plan stops the request (a switched-off module stays readable).
	const ent = useEntitlements();
	const known = ent.data ?? (ent.isLoading ? readCachedEntitlements() : undefined);
	const moduleKey = PAGE_MODULE[page];
	const moduleReadable =
		!moduleKey ||
		(ent.isLoading && !known ? false : moduleState(known, moduleKey) !== "not_in_plan");
	const canView = allowed && hasPermission && moduleReadable;
	const [open, setOpen] = useState(false);
	const [range, setRange] = useState<DateRangeValue>({ option: "this_month" });
	const [chosenGroupBy, setGroupBy] = useState<string>(BREAKDOWNS[page][0]);

	// QuickBooks breakdowns (qb_sync, qb_linked) are only used when QB is connected
	const hasQbDim = BREAKDOWNS[page].some((d) => d.startsWith("qb_"));
	const qbConnected = useQBStatusQuery(hasQbDim).data?.connected ?? false;
	const options = useMemo(() => {
		const base = BREAKDOWNS[page];
		return hasQbDim && !qbConnected ? base.filter((d) => !d.startsWith("qb_")) : base;
	}, [page, hasQbDim, qbConnected]);
	// Clamp: the chosen dimension may not exist on this page (Jobs → Plans toggle)
	const groupBy = options.includes(chosenGroupBy) ? chosenGroupBy : options[0];

	const ranged = !UNRANGED_PAGES.includes(page);
	// "All" sends no bounds, so the summary is all-time — what the control says.
	const { start, end } = useMemo(() => {
		const resolved = ranged ? resolveDateRange(range) : null;
		return { start: resolved?.start.toISOString(), end: resolved?.end.toISOString() };
	}, [range, ranged]);

	const query = usePageSummaryQuery(page, start, end, groupBy, canView);
	const snapshot = usePageSnapshotQuery(page, canView);

	return {
		page,
		label,
		canView,
		open,
		setOpen,
		range,
		setRange,
		options,
		groupBy,
		setGroupBy,
		query,
		snapshot,
		ranged,
		hrefFor: (l) => getReportHref(page, groupBy, l, range),
		canDrill:
			(groupBy === "status" && STATUS_DRILL.includes(page)) ||
			(groupBy === "priority" && PRIORITY_DRILL.includes(page)) ||
			(groupBy === "tax_exempt" && page === "clients"),
		presets: page === "recurring_plans" ? PLAN_PRESETS : PAST_PRESETS,
		chart:
			DONUT_DIMS.includes(groupBy) || (groupBy === "status" && DONUT_STATUS_PAGES.includes(page))
				? "donut"
				: "bar",
	};
}
