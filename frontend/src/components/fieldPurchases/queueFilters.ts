import type { FieldPurchaseSort, ListPurchasesParams } from "../../api/fieldPurchases";
import type { FieldPurchaseStatus } from "../../types/fieldPurchases";

/**
 * Everything the review queue can be narrowed by, in one vocabulary. The four
 * stages are mutually exclusive positions in a lifecycle; flagged/search/date
 * combine with whichever stage is showing. Keeping them apart is what lets the
 * header draw a rail and a toolbar rather than eight loose pills.
 */

export type QueueStage = "preauth" | "with_tech" | "review" | "signoff" | "decided";

/**
 * Lifecycle order, not frequency order: reading the rail left to right describes
 * the process. `with_tech` is a stage of its own because `preauth_approved` and
 * `queried` are both "dispatch answered, the technician has it now" — with no rail
 * of their own, a granted pre-approval has nowhere to be seen.
 */
export const QUEUE_STAGES: {
	id: QueueStage;
	label: string;
	status: ListPurchasesParams["status"];
	/** Decided is unbounded history — a count of it tells a dispatcher nothing. */
	counted: boolean;
	/** Whether one stage holds more than one status, so the row has to name it. */
	mixed: boolean;
}[] = [
	{ id: "preauth", label: "Pre-approvals", status: "pending_preauth", counted: true, mixed: false },
	{
		id: "with_tech",
		label: "With the technician",
		status: "with_tech",
		counted: true,
		mixed: true,
	},
	{ id: "review", label: "Awaiting review", status: "pending_review", counted: true, mixed: false },
	{
		id: "signoff",
		label: "Second sign-off",
		status: "pending_second_signoff",
		counted: true,
		mixed: false,
	},
	{ id: "decided", label: "Decided", status: "decided", counted: false, mixed: true },
];

/**
 * Which rail of the queue a purchase is currently sitting on. Exhaustive on
 * purpose: a status that falls through to a default rail lands the dispatcher on a
 * queue that does not contain the row they clicked.
 *
 * `draft` is absent because no rail holds one — see `purchaseHref`.
 */
export const STAGE_OF: Record<Exclude<FieldPurchaseStatus, "draft">, QueueStage> = {
	pending_preauth: "preauth",
	preauth_approved: "with_tech",
	queried: "with_tech",
	pending_review: "review",
	pending_second_signoff: "signoff",
	approved: "decided",
	rejected: "decided",
	preauth_denied: "decided",
};

/**
 * A link to one purchase, on the rail that contains it. Naming the record and not
 * just the rail is the point: a stage alone opens a list with nothing selected, and
 * three statuses share a stage. A draft gets no stage - nothing lists it, so any
 * rail would be a queue the row is not in.
 */
export function purchaseHref(id: string, status: FieldPurchaseStatus): string {
	const stage = status === "draft" ? null : STAGE_OF[status];
	return `/dispatch/purchases?tab=field_purchases&${stage ? `stage=${stage}&` : ""}purchase=${id}`;
}

/** Named the way a dispatcher asks for them, not as a field plus a direction. */
export const SORT_OPTIONS: { value: FieldPurchaseSort; label: string }[] = [
	{ value: "newest", label: "Newest first" },
	{ value: "oldest", label: "Oldest first" },
	{ value: "amount_desc", label: "Largest first" },
	{ value: "amount_asc", label: "Smallest first" },
];

export const EMPTY_COPY: Record<QueueStage, { title: string; description: string }> = {
	preauth: {
		title: "No pre-approvals pending",
		description: "A technician asks for one before spending over their limit.",
	},
	with_tech: {
		title: "Nothing out with a technician",
		description: "Pre-approvals you granted and receipts you sent back wait here.",
	},
	review: {
		title: "Nothing waiting on review",
		description: "Receipts land here the moment a technician submits one.",
	},
	signoff: {
		title: "No second signatures needed",
		description: "Only purchases over the org threshold reach this step.",
	},
	decided: {
		title: "Nothing decided yet",
		description: "Approved, rejected and denied purchases collect here.",
	},
};

export interface QueueFilters {
	stage: QueueStage;
	search: string;
	flagged: boolean;
	sort: FieldPurchaseSort;
}

const isStage = (v: string | null): v is QueueStage => QUEUE_STAGES.some((s) => s.id === v);

const isSort = (v: string | null): v is FieldPurchaseSort =>
	SORT_OPTIONS.some((s) => s.value === v);

/**
 * The URL is the single source of truth for the whole header. Half of it used to
 * live in component state, so a reload kept the date and the sort but silently
 * threw away the stage and the search — and no filtered view could be shared.
 */
export function readQueueFilters(params: URLSearchParams): QueueFilters {
	const stage = params.get("stage");
	const sort = params.get("sort");
	return {
		stage: isStage(stage) ? stage : "review",
		search: params.get("q")?.trim() ?? "",
		flagged: params.get("flagged") === "1",
		sort: isSort(sort) ? sort : "newest",
	};
}

/** Refinements only — the stage is the rail, and sort narrows nothing. */
export function activeRefinementCount(filters: QueueFilters, hasPeriod: boolean): number {
	return (filters.search ? 1 : 0) + (filters.flagged ? 1 : 0) + (hasPeriod ? 1 : 0);
}
