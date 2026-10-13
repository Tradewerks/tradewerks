import { History, Link2, Pencil, Plus, Repeat, Send, ShieldCheck, Trash2, Unlink, UserCheck, UserX } from "lucide-react";
import type React from "react";
import type { ActivityLog } from "../../types/logs";

export type ChangeRow = {
	key: string;
	label: string;
	from: string;
	to: string;
	refType?: RefType;
};

export type ChangeEntry = {
	headline: string;
	subtitle: string | null;
	rows: ChangeRow[];
	icon: React.ElementType;
	color: string;
	bg: string;
};

const EM_DASH = "—";

const ACTION_VERBS: Record<string, string> = {
	created: "created",
	create: "created",
	updated: "updated",
	changed: "changed",
	deleted: "deleted",
	delete: "deleted",
	attached: "attached",
	detached: "detached",
	sent: "sent",
	send: "sent",
	authorized: "authorized",
	assigned: "assigned",
	removed: "removed",
	converted: "converted",
};

type EntryStyle = { icon: React.ElementType; color: string; bg: string };

const DEFAULT_STYLE: EntryStyle = {
	icon: History,
	color: "text-text-tertiary",
	bg: "bg-zinc-500/10",
};

export const getVerb = (log: ActivityLog): string => ACTION_VERBS[log.action] ?? humanize(log.action).toLowerCase();

const VERB_STYLES: Record<string, EntryStyle> = {
	created: { icon: Plus, color: "text-success-text", bg: "bg-success/10" },
	updated: { icon: Pencil, color: "text-primary-text", bg: "bg-primary/10" },
	changed: { icon: Pencil, color: "text-primary-text", bg: "bg-primary/10" },
	deleted: { icon: Trash2, color: "text-error-text", bg: "bg-error/10" },
	attached: { icon: Link2, color: "text-info-text", bg: "bg-cyan-500/10" },
	detached: { icon: Unlink, color: "text-warning-text", bg: "bg-warning/10" },
	sent: { icon: Send, color: "text-primary-text", bg: "bg-primary/10" },
	authorized: { icon: ShieldCheck, color: "text-success-text", bg: "bg-success/10" },
	assigned: { icon: UserCheck, color: "text-success-text", bg: "bg-success/10" },
	removed: { icon: UserX, color: "text-error-text", bg: "bg-error/10" },
	converted: { icon: Repeat, color: "text-primary-text", bg: "bg-primary/10" },
};

export const OTHER_FILTER_KEY = "other";

export const ACTION_FILTERS = [
	{ key: "created", label: "Created", verbs: ["created"], ...VERB_STYLES.created },
	{ key: "updated", label: "Updated", verbs: ["updated", "changed"], ...VERB_STYLES.updated },
	{ key: "deleted", label: "Deleted", verbs: ["deleted"], ...VERB_STYLES.deleted },
	{ key: "assigned", label: "Assigned", verbs: ["assigned"], ...VERB_STYLES.assigned },
	{ key: "removed", label: "Removed", verbs: ["removed"], ...VERB_STYLES.removed },
	{ key: "attached", label: "Attached", verbs: ["attached"], ...VERB_STYLES.attached },
	{ key: "detached", label: "Detached", verbs: ["detached"], ...VERB_STYLES.detached },
	{ key: "sent", label: "Sent", verbs: ["sent"], ...VERB_STYLES.sent },
	{ key: "authorized", label: "Authorized", verbs: ["authorized"], ...VERB_STYLES.authorized },
	{ key: "converted", label: "Converted", verbs: ["converted"], ...VERB_STYLES.converted },
	// Catch-all for verbs no chip above lists (failed, push_failed, reuse_detected, …)
	{ key: OTHER_FILTER_KEY, label: "Other", verbs: [], ...DEFAULT_STYLE },
] as const;

/** The chip a log belongs to: the one listing its verb, or "Other" for anything else. */
export const actionFilterKeyFor = (log: ActivityLog): string => {
	const verb = getVerb(log);
	return (
		ACTION_FILTERS.find((f) => (f.verbs as readonly string[]).includes(verb))?.key ??
		OTHER_FILTER_KEY
	);
};

const ENTITY_LABELS: Record<string, string> = {
	job: "Job",
	job_visit: "Visit",
	job_note: "Job note",
	job_line_item: "Job line item",
	quote: "Quote",
	quote_note: "Quote note",
	quote_line_item: "Quote line item",
	request: "Request",
	request_note: "Request note",
	invoice: "Invoice",
	invoice_note: "Invoice note",
	invoice_payment: "Payment",
	client: "Client",
	client_note: "Client note",
	contact: "Contact",
	project: "Project",
	project_note: "Project note",
	technician: "Technician",
	dispatcher: "Dispatcher",
	vehicle: "Vehicle",
	vehicle_stock_item: "Stock item",
	vehicle_stock_adjustment: "Stock adjustment",
	vehicle_restock_request: "Restock request",
	vehicle_restock_record: "Restock",
	vehicle_maintenance_record: "Maintenance record",
	vehicle_maintenance_reminder: "Maintenance reminder",
	inventory_item: "Inventory item",
	recurring_plan: "Recurring plan",
	recurring_occurrence: "Recurring occurrence",
	organization_role: "Role",
	organization_role_assignment: "Role assignment",
	saved_report: "Saved report",
	mfa: "Two-factor authentication",
	organization: "Organization settings",
};

const HEADLINE_OVERRIDES: Record<string, string> = {
	"project.job_attached": "Job attached",
	"project.job_detached": "Job detached",
	"quote.converted": "Quote converted to job",
	"request.converted": "Request converted to job",
	"request.quoted": "Request converted to quote",
	"request.quote_approved": "Linked quote approved",
	"request.quote_rejected": "Linked quote rejected",
};

const humanize = (raw: string): string => {
	const spaced = raw.replace(/[_.]+/g, " ").trim();
	return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "";
};

const FIELD_LABELS: Record<string, string> = {
	scheduled_start_at: "Scheduled start",
	scheduled_end_at: "Scheduled end",
	actual_start_at: "Actual start",
	actual_end_at: "Actual end",
	target_end_at: "Target end",
	starts_at: "Start date",
	completed_at: "Completed",
	issue_date: "Created date",
	due_date: "Due date",
	client_id: "Client",
	project_id: "Project",
	job_id: "Job",
	manager_dispatcher_id: "Manager",
	organization_role_id: "Role",
	tech_status: "Technician status",
	qb_sync_status: "QuickBooks sync",
	is_active: "Active",
	tax_exempt: "Tax exempt",
	estimated_total: "Estimated total",
	actual_total: "Actual total",
	balance_due: "Balance due",
	amount_paid: "Amount paid",
	discount_amount: "Discount",
	tax_amount: "Tax",
	tax_rate: "Tax rate",
	unit_price: "Unit price",
	internal_notes: "Internal notes",
	dispute_resolution: "Dispute outcome",
	// Not in ID_REF_FIELDS: a replacement is a quote on a quote's log and an
	// invoice on an invoice's, and RefType is keyed by field name alone with no
	// way to vary by the log row's entity. A labelled UUID still beats a bare one.
	replacement: "Replacement document",
	restock_mode: "Vehicle restock workflow",
	measurement_system: "Measurement system",
	field_purchase_second_signoff_threshold: "Second sign-off threshold",
	brand_color: "Brand color",
};

// Enum-valued fields whose stored code is not a readable word.
const VALUE_LABELS: Record<string, Record<string, string>> = {
	restock_mode: { tech_self_serve: "Technician self-serve", dispatch_prepared: "Dispatch prepared" },
	measurement_system: { imperial: "Imperial", metric: "Metric" },
};

const labelFor = (key: string): string => FIELD_LABELS[key] ?? humanize(key);

// Denormalized context, not field edits — these belong in the subtitle, not rows.
const BREADCRUMB_KEYS = new Set([
	"client_name",
	"job_number",
	"quote_number",
	"invoice_number",
	"request_number",
	"project_number",
]);

const isBreadcrumb = (key: string): boolean => key.startsWith("_") || BREADCRUMB_KEYS.has(key);

// Never render credential-ish fields, whatever the backend happened to log for them.
const SENSITIVE_KEY = /password|token|secret|otp|mfa/i;

export const isSensitiveKey = (key: string): boolean => SENSITIVE_KEY.test(key);

const REFERENCE_KEYS = [
	"_job_number",
	"job_number",
	"_quote_number",
	"quote_number",
	"_invoice_number",
	"invoice_number",
	"_project_number",
	"project_number",
];

const readBreadcrumb = (log: ActivityLog, keys: string[]): string | null => {
	if (!log.changes) return null;
	for (const key of keys) {
		const value = log.changes[key]?.new;
		if (typeof value === "string" && value.trim()) return value;
	}
	return null;
};

const buildSubtitle = (log: ActivityLog): string | null => {
	const parts = [
		readBreadcrumb(log, REFERENCE_KEYS),
		readBreadcrumb(log, ["client_name", "_client_name"]),
	].filter(Boolean) as string[];
	return parts.length ? parts.join(" · ") : null;
};

// buildChanges stores raw values: Dates arrive as ISO strings, Prisma Decimals as strings.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A Decimal-as-string looks like any numeric string, so money is matched by name.
const CURRENCY_FIELDS = new Set([
	"total",
	"subtotal",
	"amount",
	"amount_paid",
	"balance_due",
	"budget",
	"cost",
	"price",
	"unit_price",
	"tax_amount",
	"discount_amount",
	"estimated_total",
	"actual_total",
	"estimated_value",
	"field_purchase_second_signoff_threshold",
]);

// Money-ish names that are not money. `discount_value` is a percent OR an amount
const NEVER_CURRENCY = new Set(["tax_rate", "discount_value", "quantity", "generated_count"]);

// Stored at UTC midnight — rendering in the org timezone shows the previous day.
const DATE_ONLY_FIELDS = new Set(["starts_at", "target_end_at", "due_date", "issue_date", "performed_at", "due_at", "baseline_at"]);

export const formatValue = (key: string, value: unknown, tz: string): string => {
	if (value === null || value === undefined || value === "") return EM_DASH;

	if (typeof value === "string" && VALUE_LABELS[key]?.[value]) return VALUE_LABELS[key][value];

	if (typeof value === "boolean") return value ? "Yes" : "No";

	if (Array.isArray(value)) {
		const readable = value.filter(
			(v) => (typeof v === "string" && !UUID.test(v)) || typeof v === "number",
		);
		return readable.length ? readable.join(", ") : EM_DASH;
	}

	if (typeof value === "object") {
		const obj = value as Record<string, unknown>;
		if ("lat" in obj && "lon" in obj) return `${obj.lat}, ${obj.lon}`;
		return JSON.stringify(value);
	}

	if (CURRENCY_FIELDS.has(key) && !NEVER_CURRENCY.has(key)) {
		const n = typeof value === "number" ? value : parseFloat(String(value));
		if (isFinite(n)) return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
	}

	if (typeof value === "string" && ISO_TIMESTAMP.test(value)) {
		const d = new Date(value);
		if (!isNaN(d.getTime())) {
			const dateOnly = DATE_ONLY_FIELDS.has(key) || !value.includes("T");
			return d.toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				year: "numeric",
				...(dateOnly
					? { timeZone: "UTC" }
					: { hour: "numeric", minute: "2-digit", timeZone: tz }),
			});
		}
	}

	if (typeof value === "number") return value.toLocaleString("en-US");

	return String(value);
};

export const entityLabelFor = (entityType: string): string => ENTITY_LABELS[entityType] ?? humanize(entityType);

export const formatChange = (log: ActivityLog, tz: string): ChangeEntry => {
	const verb = getVerb(log);
	const entity = entityLabelFor(log.entity_type);

	const rows: ChangeRow[] = log.changes
		? Object.entries(log.changes).flatMap(([key, delta]) => {
				if (isBreadcrumb(key) || isSensitiveKey(key)) return [];

				const from = formatValue(key, delta.old, tz);
				const to = key === "acknowledged_at" && delta.new == null
					? "Unacknowledged"
					: formatValue(key, delta.new, tz);
				if (from === to) return [];

				return [{ key, label: labelFor(key), from, to, refType: ID_REF_FIELDS[key]}];
			})
		: [];

	return {
		headline:
			HEADLINE_OVERRIDES[log.event_type] ??
			([entity, verb].filter(Boolean).join(" ") || "Change recorded"),
		subtitle: buildSubtitle(log),
		rows,
		...(VERB_STYLES[verb] ?? DEFAULT_STYLE),
	};
};

export type RefType = "client" | "project" | "dispatcher" | "organization_role" | "job" | "recurring_plan";

export const ID_REF_FIELDS: Record<string, RefType> = {
	client_id: "client",
	project_id: "project",
	manager_dispatcher_id: "dispatcher",
	organization_role_id: "organization_role",
	job_id: "job",
}