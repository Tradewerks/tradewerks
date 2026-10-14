import { formatCurrency } from "../../util/util";
import type { LinkageEntity, LinkageMatchTier, ReconcileLineRow } from "../../api/inventory";

/**
 * Formatting and vocabulary shared by the reconcile surfaces. Split from the
 * components so a fast-refresh boundary holds: a module exporting both a
 * constant and a component cannot be hot-reloaded cleanly.
 */

export const COL_LABEL = "text-[10px] font-semibold uppercase tracking-wider text-text-tertiary";

export const FOCUS_RING =
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-border";

/** Exact, for a line total somebody will reconcile against a document. */
export const money = (v: number) => formatCurrency(v);

/** Rounded, for ranked rows and the stat strip, where cents are noise. */
export const moneyRound = (v: number) =>
	v.toLocaleString("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 0,
	});

export const ENTITY_LABELS: Record<LinkageEntity, string> = {
	quote: "Quotes",
	job: "Jobs",
	job_visit: "Visits",
	recurring_plan: "Plans",
	invoice: "Invoices",
};

export const ENTITY_SINGULAR: Record<LinkageEntity, string> = {
	quote: "Quote",
	job: "Job",
	job_visit: "Visit",
	recurring_plan: "Plan",
	invoice: "Invoice",
};

export const TIER_LABELS: Record<LinkageMatchTier, string> = {
	exact: "Exact name",
	case_insensitive: "Name match",
	code: "SKU match",
};

/** Only an exact hit is safe to accept without a human reading it first. */
export const isAutoAcceptable = (tier: LinkageMatchTier | undefined) => tier === "exact";

type DocRef = Pick<ReconcileLineRow, "entity" | "document_id" | "parent_id">;

/** Where the document lives. The visit route nests, so it needs its job. */
export function documentHref(row: DocRef): string | null {
	switch (row.entity) {
		case "quote":
			return `/dispatch/quotes/${row.document_id}`;
		case "job":
			return `/dispatch/jobs/${row.document_id}`;
		case "job_visit":
			return row.parent_id
				? `/dispatch/jobs/${row.parent_id}/visits/${row.document_id}`
				: null;
		case "recurring_plan":
			return `/dispatch/recurring-plans/${row.document_id}`;
		case "invoice":
			return `/dispatch/invoices/${row.document_id}`;
	}
}

/** A number where the document has one, its name where it does not (plans). */
export function documentLabel(
	row: Pick<ReconcileLineRow, "entity" | "document_number" | "document_title">
): string {
	const kind = ENTITY_SINGULAR[row.entity];
	if (row.document_number) return `${kind} #${row.document_number}`;
	if (row.document_title) return `${kind} · ${row.document_title}`;
	return kind;
}

export function shortDate(iso: string | null): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "—";
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

export function lineCountLabel(n: number): string {
	return `${n} line${n === 1 ? "" : "s"}`;
}
