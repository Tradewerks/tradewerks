import type { ItemOrigin, ReconcileSort } from "../../api/inventory";
import { ITEM_ORIGIN_LABELS } from "../../api/inventory";

/**
 * Everything the surface can be narrowed by, in one vocabulary. The three tabs are
 * mutually exclusive kinds of problem; search/origin/sort combine with whichever tab
 * is showing. Keeping them apart lets the header draw a rail and a toolbar instead
 * of a pile of loose pills.
 */

export type ReconcileTab = "detail" | "unmapped" | "intentional";

export const RECONCILE_TABS: { id: ReconcileTab; label: string; counted: boolean }[] = [
	{ id: "unmapped", label: "Unmapped names", counted: true },
	{ id: "detail", label: "Needs detail", counted: true },
	// A decision log, not a backlog — a count of it is not work.
	{ id: "intentional", label: "Marked intentional", counted: false },
];

/**
 * A link to one row, on the tab that holds it. `row` is that tab's own key. The
 * search is set as well, because the list is capped and ranked by value: a $6
 * grommet can sit past the cap, and the pane would open on a part the list beside
 * it does not contain.
 */
export function reconcileHref(tab: ReconcileTab, row: string, search = row): string {
	const params = new URLSearchParams({ tab, row });
	if (search) params.set("q", search);
	return `/dispatch/inventory/reconcile?${params.toString()}`;
}

export const SORT_OPTIONS: { value: ReconcileSort; label: string }[] = [
	{ value: "value_desc", label: "Highest value" },
	{ value: "value_asc", label: "Lowest value" },
	{ value: "lines_desc", label: "Most lines" },
	{ value: "name_asc", label: "Name A–Z" },
];

export const ORIGIN_OPTIONS: { value: ItemOrigin; label: string }[] = (
	["tech_submission", "dispatch_quick_add", "field_purchase", "import"] as ItemOrigin[]
).map((value) => ({ value, label: ITEM_ORIGIN_LABELS[value] }));

export const EMPTY_COPY: Record<ReconcileTab, { title: string; description: string }> = {
	detail: {
		title: "Nothing waiting for detail",
		description:
			"Parts land here when a tech or a quick-add creates them without a cost basis.",
	},
	unmapped: {
		title: "Every material line points at a catalog item",
		description: "Nothing is billing a part the catalog cannot deduct from stock.",
	},
	intentional: {
		title: "Nothing marked intentional yet",
		description: "A one-off gasket or a subcontractor's own material belongs here.",
	},
};

export interface ReconcileFilters {
	tab: ReconcileTab;
	search: string;
	/** Narrows the provisional half only; a bare name has no origin to filter on. */
	origin: ItemOrigin | null;
	sort: ReconcileSort;
}

const isTab = (v: string | null): v is ReconcileTab => RECONCILE_TABS.some((t) => t.id === v);
const isSort = (v: string | null): v is ReconcileSort => SORT_OPTIONS.some((s) => s.value === v);
const isOrigin = (v: string | null): v is ItemOrigin => ORIGIN_OPTIONS.some((o) => o.value === v);

/**
 * The URL is the single source of truth: a reload does not throw the tab and
 * origin away, and a narrowed view can be shared with whoever owns the catalog.
 */
export function readReconcileFilters(params: URLSearchParams): ReconcileFilters {
	const tab = params.get("tab");
	const sort = params.get("sort");
	const origin = params.get("origin");
	return {
		// Unmapped first: it is the half where money is already being billed.
		tab: isTab(tab) ? tab : "unmapped",
		search: params.get("q")?.trim() ?? "",
		origin: isOrigin(origin) ? origin : null,
		sort: isSort(sort) ? sort : "value_desc",
	};
}

/** Refinements only — the tab is the rail, and sort hides nothing. */
export function activeRefinementCount(filters: ReconcileFilters): number {
	return (filters.search ? 1 : 0) + (filters.origin ? 1 : 0);
}
