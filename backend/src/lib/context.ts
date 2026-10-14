import type { Request } from "express";
import { db } from "../db.js";

export interface UserContext {
	techId?: string;
	dispatcherId?: string;
	organizationId?: string;
	ipAddress?: string;
	userAgent?: string;
}


// Actor identity comes exclusively from the verified JWT (req.user). Request
// headers are client-controlled and must never be able to override it.
export const getUserContext = (req: Request): UserContext => {
	const userAgent = req.headers["user-agent"] || undefined;
	const userId = req.user?.uid;
	const role = req.user?.role;
	const isTech = role === "technician";
	const isDispatcher = role === "dispatcher" || role === "admin";

	return {
		techId: isTech ? userId : undefined,
		dispatcherId: isDispatcher ? userId : undefined,
		ipAddress: undefined,
		userAgent,
	};
};

// Models that carry an organization_id column and are filtered per-org directly.
const ORG_SCOPED_MODELS = new Set([
	"contact",
	"client",
	"client_note",
	"request",
	"request_note",
	"quote",
	"quote_note",
	"job",
	"job_note",
	"recurring_plan",
	"recurring_plan_note",
	"form_draft",
	"inventory_item",
	"inventory_tag",
	"inventory_import",
	"inventory_import_source",
	"inventory_import_candidate",
	"inventory_import_change",
	"inventory_variant_group",
	"technician",
	"dispatcher",
	"invoice",
	"invoice_note",
	"log",
	"vehicle",
	"stock_movement",
	"serial_unit",
	"stock_batch",
	"vehicle_restock_record",
	"vehicle_stock_adjustment",
	"vehicle_restock_request",
	"vehicle_readiness",
	"tax_rate",
	"tax_group",
	"organization_role",
	"saved_report",
	"report_favorite",
	"followup_sequence",
	"followup_enrollment",
	"followup_send",
	"email_template",
	"project",
	"field_purchase",
	"field_purchase_grant",
	"field_purchase_event",
	"assistant_conversation",
	"document_dispute",
	"vehicle_maintenance_record",
	"vehicle_maintenance_reminder",
	"purchase",
	"timesheet_week",
	"shift_correction",
	"visit_tech_arrival",
]);

/**
 * Models with no organization_id column: org ownership is enforced through a
 * parent relation. Each entry maps to the relation-filter fragment that pins the
 * row to the caller's org. Registering a model here gives it the same tenancy
 * guarantees as an org-scoped model — reads are filtered, writes are guarded.
 *
 * Models still relying on caller-provided parent scoping (not auto-enforced):
 * job_visit_line_item, job_visit_technician, quote_line_item,
 * recurring_occurrence, invoice_line_item, invoice_payment, client_contact.
 * Add them here as needed.
 *
 * Keys are matched by exact string against the Prisma model name, which is
 * lowercase (`schema.prisma`) — a capitalised key silently matches nothing and
 * injects no filter, which reads as registered but is a no-op.
 */
const RELATION_SCOPED_MODELS: Record<string, (organizationId: string) => Record<string, unknown>> = {
	vehicle_stock_item: (o) => ({ vehicle: { organization_id: o } }),
	vehicle_restock_line: (o) => ({ stock_item: { vehicle: { organization_id: o } } }),
	vehicle_stock_adjustment_line: (o) => ({ stock_item: { vehicle: { organization_id: o } } }),
	vehicle_stock_usage: (o) => ({ stock_item: { vehicle: { organization_id: o } } }),
	item_external_mapping: (o) => ({ inventory_item: { organization_id: o } }),
	job_visit: (o) => ({ job: { organization_id: o } }),
	vehicle_stock_batch: (o) => ({ vehicle: { organization_id: o } }),
	stock_movement_serial: (o) => ({ movement: { organization_id: o } }),
	stock_movement_batch: (o) => ({ movement: { organization_id: o } }),
	visit_tech_time_entry: (o) => ({ visit: { job: { organization_id: o } } }),
	visit_tech_drive: (o) => ({ tech: { organization_id: o } }),
	field_purchase_line: (o) => ({ field_purchase: { organization_id: o } }),
	purchase_line: (o) => ({ purchase: { organization_id: o } }),
	field_purchase_job_allocation: (o) => ({ field_purchase: { organization_id: o } }),
	assistant_message: (o) => ({ conversation: { organization_id: o } }),
	assistant_tool_call: (o) => ({ message: { conversation: { organization_id: o } } }),
	technician_notification: (o) => ({ technician: { organization_id: o } }),
	dispatcher_notification: (o) => ({ dispatcher: { organization_id: o } }),
	technician_shift: (o) => ({ tech: {organization_id: o }}),
	technician_shift_break: (o) => ({ shift: { tech: { organization_id: o }}}),
};

// Returns the where-fragment that pins a row to the caller's org, or null if the
// model is not tenant-scoped.
function scopeFilter(model: string, organizationId: string): Record<string, unknown> | null {
	if (ORG_SCOPED_MODELS.has(model)) return { organization_id: organizationId };
	const rel = RELATION_SCOPED_MODELS[model];
	return rel ? rel(organizationId) : null;
}

// AND-composes the caller's org filter into a scoped query's where clause,
// leaving args untouched for non-tenant-scoped models.
function scopedArgs<A extends { where?: unknown }>(model: string, args: A, organizationId: string): A {
	const f = scopeFilter(model, organizationId);
	if (f) (args as any).where = { AND: [args.where ?? {}, f] };
	return args;
}

// Merges the org filter into a single-row where clause as SIBLING properties
// (not AND-wrapped) alongside the caller's unique identifier — Prisma supports
// filtering update/delete on non-unique fields this way, and (unlike a separate
// pre-check query) it's the exact same query the caller already runs, so it
// naturally participates in whatever transaction that query is part of and sees
// that transaction's own uncommitted writes (e.g. a batch row created moments
// earlier via getOrCreateBatch in the same still-open transaction). A mismatch
// (wrong org, or no such row) makes Prisma itself throw its native P2025.
function uniqueScopedWhere(model: string, where: unknown, organizationId: string): unknown {
	const f = scopeFilter(model, organizationId);
	if (!f) return where;
	return { ...(where as Record<string, unknown>), ...f };
}

// Forces create/upsert-create data onto the caller's org, defeating spoofed
// organization_id / organization.connect payloads.
function forceOrg<T>(data: T, organizationId: string): T {
	if (Array.isArray(data)) return data.map((d) => forceOrg(d, organizationId)) as unknown as T;
	if (!data || typeof data !== "object") return data;
	const { organization, ...rest } = data as Record<string, unknown>;
	return (
		organization !== undefined
			? { ...rest, organization: { connect: { id: organizationId } } }
			: { ...rest, organization_id: organizationId }
	) as unknown as T;
}

/**
 * Returns a Prisma client scoped to an organization. Every tenant-scoped model
 * (org-scoped or relation-scoped) is enforced automatically:
 *
 * - reads (findMany/findFirst/count/aggregate/groupBy) inject the org filter;
 * - update/delete merge the org filter into the where clause as a sibling of
 *   the caller's unique identifier (Prisma's "filter on non-unique fields"
 *   support) rather than a separate ownership pre-check query — it's the same
 *   query the caller already runs, so it naturally sees whatever transaction
 *   that query is part of (a separate pre-check query would run on its own
 *   connection and miss uncommitted writes from an still-open transaction).
 *   A foreign-org or missing row makes Prisma itself throw its native P2025;
 * - create/createMany force the caller's org into the data (spoofing impossible);
 * - upsert forces the caller's org into its create branch;
 * - findUnique/findUniqueOrThrow reroute to a scoped findFirst/findFirstOrThrow.
 *
 * The only rule for adding a model: register it in ORG_SCOPED_MODELS (has an
 * organization_id column) or RELATION_SCOPED_MODELS (scoped via a parent).
 *
 * Note: upsert is not ownership-guarded (its unique where may be a composite key
 * that can't safely absorb an extra sibling filter) — it only force-scopes the
 * create branch.
 */
export function getScopedDb(organizationId: string) {
	return db.$extends({
		query: {
			$allModels: {
				async findMany({ model, args, query }) {
					return query(scopedArgs(model, args, organizationId));
				},
				async findFirst({ model, args, query }) {
					return query(scopedArgs(model, args, organizationId));
				},
				async count({ model, args, query }) {
					return query(scopedArgs(model, args, organizationId));
				},
				async aggregate({ model, args, query }) {
					return query(scopedArgs(model, args, organizationId));
				},
				async groupBy({ model, args, query }) {
					return query(scopedArgs(model, args, organizationId));
				},
				async updateMany({ model, args, query }) {
					return query(scopedArgs(model, args, organizationId));
				},
				async deleteMany({ model, args, query }) {
					return query(scopedArgs(model, args, organizationId));
				},
				async update({ model, args, query }) {
					args.where = uniqueScopedWhere(model, args.where, organizationId) as typeof args.where;
					return query(args);
				},
				async delete({ model, args, query }) {
					args.where = uniqueScopedWhere(model, args.where, organizationId) as typeof args.where;
					return query(args);
				},
				async upsert({ model, args, query }) {
					if (ORG_SCOPED_MODELS.has(model)) args.create = forceOrg(args.create, organizationId);
					return query(args);
				},
				async create({ model, args, query }) {
					if (ORG_SCOPED_MODELS.has(model)) args.data = forceOrg(args.data, organizationId);
					return query(args);
				},
				async createMany({ model, args, query }) {
					if (ORG_SCOPED_MODELS.has(model)) args.data = forceOrg(args.data, organizationId);
					return query(args);
				},
				async findUnique({ model, args, query }) {
					// Merge the org filter as a sibling of the unique identifier (same trick as
					// uniqueScopedWhere for update/delete) and keep the original findUnique
					// operation, so this stays on `query` — the transaction-aware client Prisma
					// already bound this call to. Rerouting to a different model/operation (e.g.
					// findFirst on `db`) would run on a separate connection that can't see this
					// transaction's own uncommitted writes.
					args.where = uniqueScopedWhere(model, args.where, organizationId) as typeof args.where;
					return query(args);
				},
				async findUniqueOrThrow({ model, args, query }) {
					args.where = uniqueScopedWhere(model, args.where, organizationId) as typeof args.where;
					return query(args);
				},
			},
		},
	});
}
