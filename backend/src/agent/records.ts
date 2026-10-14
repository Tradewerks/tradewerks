/**
 * Record loaders: the projections behind `get_record` and `list_records`.
 *
 * These deliberately do NOT call the domain controllers, which is a departure
 * worth explaining. `getAllJobs` and friends are written for the dispatcher UI
 * and include everything a page might render — every visit, every visit's line
 * items and assigned technicians, the recurring plan with its rules and
 * upcoming occurrences. That is right for a React page and wrong for a model:
 * a single job can serialize to tens of kilobytes, and a list of them will
 * exhaust a context window before it answers anything.
 *
 * So reads use explicit `select` projections sized for an agent. They still run
 * through `getScopedDb`, so tenancy is enforced identically; what changes is
 * only how much comes back. Writes (Phase 3) go the other way and must call the
 * controllers, because that is where the business rules live.
 */

import type { Prisma } from "../../generated/prisma/client.js";
import type { ScopedDb } from "./types.js";

export const RECORD_TYPES = [
	"client",
	"job",
	"visit",
	"quote",
	"request",
	"invoice",
	"project",
	"recurring_plan",
	"technician",
	"inventory_item",
] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

/** Status values per type, so a bad filter fails validation instead of reaching Prisma. */
export const RECORD_STATUSES: Record<RecordType, readonly string[]> = {
	client: [],
	job: ["Unscheduled", "Scheduled", "InProgress", "Completed", "Cancelled"],
	visit: ["Scheduled", "Driving", "OnSite", "InProgress", "Paused", "Delayed", "Completed", "Cancelled"],
	quote: ["Draft", "Issued", "Sent", "Viewed", "Approved", "Rejected", "Revised", "Expired", "Cancelled"],
	request: ["New", "Reviewing", "Quoted", "QuoteApproved", "QuoteRejected", "ConvertedToJob", "Cancelled"],
	invoice: ["Draft", "Issued", "Sent", "Viewed", "PartiallyPaid", "Paid", "Disputed", "Void"],
	project: ["Planning", "Active", "OnHold", "Completed", "Cancelled"],
	recurring_plan: ["Active", "Paused", "Completed", "Cancelled"],
	technician: ["Offline", "Available", "Break", "EnRoute", "OnSite", "Working", "Paused", "WrappingUp", "HeadingBack"],
	inventory_item: [],
};

/**
 * Which filters each type actually supports.
 *
 * A filter that a loader ignores is worse than one it rejects: the model asks
 * for "technicians for client X", gets every technician back, and reports them
 * as that client's. Declaring capability here lets `list_records` refuse the
 * combination instead of answering a different question than the one asked.
 */
export const RECORD_FILTERS: Record<RecordType, { client: boolean; dates: boolean }> = {
	client: { client: false, dates: true },
	job: { client: true, dates: true },
	visit: { client: true, dates: true },
	quote: { client: true, dates: true },
	request: { client: true, dates: true },
	invoice: { client: true, dates: true },
	project: { client: true, dates: true },
	recurring_plan: { client: true, dates: true },
	technician: { client: false, dates: false },
	inventory_item: { client: false, dates: false },
};

/** Which date column each type's `since`/`until` filters, so the model knows what it bounded. */
export const RECORD_DATE_FIELD: Partial<Record<RecordType, string>> = {
	client: "created_at",
	job: "created_at",
	visit: "scheduled_start_at",
	quote: "created_at",
	request: "created_at",
	invoice: "created_at",
	project: "created_at",
	recurring_plan: "starts_at",
};

export const RECORD_PERMISSIONS: Record<RecordType, readonly string[]> = {
	client: ["view_clients"],
	job: ["view_jobs", "view_assigned_jobs", "view_all_jobs"],
	visit: ["view_jobs", "view_visits", "view_all_jobs", "view_assigned_jobs"],
	quote: ["view_quotes"],
	request: ["view_requests"],
	invoice: ["view_invoices"],
	project: ["view_projects"],
	recurring_plan: ["view_recurring_plans"],
	technician: ["view_technicians", "view_team_schedule"],
	inventory_item: ["view_inventory"],
};

export interface ListFilters {
	limit: number;
	status?: string;
	clientId?: string;
	/** Inclusive lower bound on the type's primary date column. */
	since?: Date;
	/** Inclusive upper bound on the type's primary date column. */
	until?: Date;
}

export interface ListOutcome {
	rows: unknown[];
	/** Total matching rows before the limit, so the model knows what it did not see. */
	total: number;
}

// ── Value coercion ──────────────────────────────────────────────────────────
// Prisma Decimals serialize to strings, and dates to Date objects. Both reach a
// model as JSON, where a string "1250.00" invites arithmetic mistakes and a Date
// stringifies inconsistently. Normalise once, here.

type Dec = Prisma.Decimal | number | null | undefined;

const money = (d: Dec): number | undefined => (d == null ? undefined : Number(d));
const iso = (d: Date | null | undefined): string | undefined => d?.toISOString();

/** Strip undefined keys so an empty field costs no tokens. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined && v !== null) out[k] = v;
	}
	return out as Partial<T>;
}

/** Trim long free text. The model rarely needs a 4 KB description to decide something. */
const clip = (s: string | null | undefined, max = 400): string | undefined => {
	if (!s) return undefined;
	const t = s.trim();
	if (!t) return undefined;
	return t.length > max ? `${t.slice(0, max)}…` : t;
};

const dateRange = (f: ListFilters) =>
	f.since || f.until ? { ...(f.since ? { gte: f.since } : {}), ...(f.until ? { lte: f.until } : {}) } : undefined;

// ── Selects ─────────────────────────────────────────────────────────────────

const clientRef = { select: { id: true, name: true } } as const;

interface RecordLoader {
	get(db: ScopedDb, id: string): Promise<unknown | null>;
	list(db: ScopedDb, filters: ListFilters): Promise<ListOutcome>;
}

export const RECORD_LOADERS: Record<RecordType, RecordLoader> = {
	// ── Client ──────────────────────────────────────────────────────────
	client: {
		async get(db, id) {
			const r = await db.client.findFirst({
				where: { id },
				select: {
					id: true,
					name: true,
					address: true,
					is_active: true,
					is_tax_exempt: true,
					created_at: true,
					last_activity: true,
					contacts: {
						select: {
							is_primary: true,
							contact: { select: { id: true, name: true, email: true, phone: true } },
						},
					},
					_count: { select: { jobs: true, quotes: true, requests: true, invoices: true } },
				},
			});
			if (!r) return null;
			return compact({
				id: r.id,
				type: "client",
				name: r.name,
				address: r.address,
				is_active: r.is_active,
				is_tax_exempt: r.is_tax_exempt,
				created_at: iso(r.created_at),
				last_activity: iso(r.last_activity),
				contacts: r.contacts.map((c) =>
					compact({
						id: c.contact.id,
						name: c.contact.name,
						email: c.contact.email,
						phone: c.contact.phone,
						is_primary: c.is_primary || undefined,
					}),
				),
				counts: r._count,
			});
		},
		async list(db, f) {
			const where: Prisma.clientWhereInput = compact({
				created_at: dateRange(f),
			});
			const [rows, total] = await Promise.all([
				db.client.findMany({
					where,
					select: { id: true, name: true, address: true, is_active: true, last_activity: true },
					orderBy: { last_activity: "desc" },
					take: f.limit,
				}),
				db.client.count({ where }),
			]);
			return {
				rows: rows.map((r) =>
					compact({
						id: r.id,
						name: r.name,
						address: r.address,
						is_active: r.is_active,
						last_activity: iso(r.last_activity),
					}),
				),
				total,
			};
		},
	},

	// ── Job ─────────────────────────────────────────────────────────────
	job: {
		async get(db, id) {
			const r = await db.job.findFirst({
				where: { id },
				select: {
					id: true,
					job_number: true,
					name: true,
					description: true,
					status: true,
					priority: true,
					address: true,
					created_at: true,
					completed_at: true,
					cancellation_reason: true,
					estimated_total: true,
					actual_total: true,
					client: clientRef,
					quote: { select: { id: true, quote_number: true, status: true } },
					request: { select: { id: true, title: true, status: true } },
					project: { select: { id: true, project_number: true, name: true } },
					line_items: {
						// job_line_item has no sort_order column (unlike quote/invoice/visit
						// line items) — insertion order is the only ordering available.
						select: { id: true, name: true, quantity: true, unit_price: true, total: true, item_type: true },
						orderBy: { created_at: "asc" },
						take: 50,
					},
					visits: {
						select: {
							id: true,
							name: true,
							status: true,
							scheduled_start_at: true,
							scheduled_end_at: true,
							visit_techs: { select: { tech: { select: { id: true, name: true } } } },
						},
						orderBy: { scheduled_start_at: "asc" },
						take: 25,
					},
					_count: { select: { visits: true, notes: true } },
				},
			});
			if (!r) return null;
			return compact({
				id: r.id,
				type: "job",
				job_number: r.job_number,
				name: r.name,
				description: clip(r.description),
				status: r.status,
				priority: r.priority,
				address: r.address,
				client: r.client,
				quote: r.quote ?? undefined,
				request: r.request ?? undefined,
				project: r.project ?? undefined,
				created_at: iso(r.created_at),
				completed_at: iso(r.completed_at),
				cancellation_reason: r.cancellation_reason ?? undefined,
				estimated_total: money(r.estimated_total),
				actual_total: money(r.actual_total),
				line_items: r.line_items.map((l) =>
					compact({
						id: l.id,
						name: l.name,
						quantity: money(l.quantity),
						unit_price: money(l.unit_price),
						total: money(l.total),
						item_type: l.item_type ?? undefined,
					}),
				),
				visits: r.visits.map((v) =>
					compact({
						id: v.id,
						name: v.name ?? undefined,
						status: v.status,
						scheduled_start_at: iso(v.scheduled_start_at),
						scheduled_end_at: iso(v.scheduled_end_at),
						technicians: v.visit_techs.map((t) => t.tech.name),
					}),
				),
				// visits[] is capped at 25; counts tell the model when it is seeing a subset.
				counts: r._count,
			});
		},
		async list(db, f) {
			const where: Prisma.jobWhereInput = compact({
				status: f.status as Prisma.jobWhereInput["status"],
				client_id: f.clientId,
				created_at: dateRange(f),
			});
			const [rows, total] = await Promise.all([
				db.job.findMany({
					where,
					select: {
						id: true,
						job_number: true,
						name: true,
						status: true,
						priority: true,
						address: true,
						created_at: true,
						estimated_total: true,
						client: clientRef,
					},
					orderBy: { created_at: "desc" },
					take: f.limit,
				}),
				db.job.count({ where }),
			]);
			return {
				rows: rows.map((r) =>
					compact({
						id: r.id,
						job_number: r.job_number,
						name: r.name,
						status: r.status,
						priority: r.priority,
						address: r.address,
						client: r.client?.name,
						created_at: iso(r.created_at),
						estimated_total: money(r.estimated_total),
					}),
				),
				total,
			};
		},
	},

	// ── Visit ───────────────────────────────────────────────────────────
	visit: {
		async get(db, id) {
			const r = await db.job_visit.findFirst({
				where: { id },
				select: {
					id: true,
					name: true,
					description: true,
					status: true,
					scheduled_start_at: true,
					scheduled_end_at: true,
					actual_start_at: true,
					actual_end_at: true,
					arrival_constraint: true,
					finish_constraint: true,
					cancellation_reason: true,
					total: true,
					job: {
						select: {
							id: true,
							job_number: true,
							name: true,
							address: true,
							client: clientRef,
						},
					},
					visit_techs: { select: { tech_status: true, tech: { select: { id: true, name: true } } } },
					line_items: {
						select: { id: true, name: true, quantity: true, unit_price: true, total: true },
						orderBy: { sort_order: "asc" },
						take: 50,
					},
				},
			});
			if (!r) return null;
			return compact({
				id: r.id,
				type: "visit",
				name: r.name ?? undefined,
				description: clip(r.description),
				status: r.status,
				scheduled_start_at: iso(r.scheduled_start_at),
				scheduled_end_at: iso(r.scheduled_end_at),
				actual_start_at: iso(r.actual_start_at),
				actual_end_at: iso(r.actual_end_at),
				arrival_constraint: r.arrival_constraint,
				finish_constraint: r.finish_constraint,
				cancellation_reason: r.cancellation_reason ?? undefined,
				total: money(r.total),
				job: compact({
					id: r.job.id,
					job_number: r.job.job_number,
					name: r.job.name,
					address: r.job.address,
					client: r.job.client?.name,
				}),
				technicians: r.visit_techs.map((t) => ({ id: t.tech.id, name: t.tech.name, status: t.tech_status })),
				line_items: r.line_items.map((l) =>
					compact({
						id: l.id,
						name: l.name,
						quantity: money(l.quantity),
						unit_price: money(l.unit_price),
						total: money(l.total),
					}),
				),
			});
		},
		async list(db, f) {
			const where: Prisma.job_visitWhereInput = compact({
				status: f.status as Prisma.job_visitWhereInput["status"],
				scheduled_start_at: dateRange(f),
				job: f.clientId ? { client_id: f.clientId } : undefined,
			});
			const [rows, total] = await Promise.all([
				db.job_visit.findMany({
					where,
					select: {
						id: true,
						name: true,
						status: true,
						scheduled_start_at: true,
						scheduled_end_at: true,
						job: { select: { id: true, job_number: true, address: true, client: clientRef } },
						visit_techs: { select: { tech: { select: { id: true, name: true } } } },
					},
					orderBy: { scheduled_start_at: "asc" },
					take: f.limit,
				}),
				db.job_visit.count({ where }),
			]);
			return {
				rows: rows.map((r) =>
					compact({
						id: r.id,
						name: r.name ?? undefined,
						status: r.status,
						scheduled_start_at: iso(r.scheduled_start_at),
						scheduled_end_at: iso(r.scheduled_end_at),
						job_id: r.job.id,
						job_number: r.job.job_number,
						address: r.job.address,
						client: r.job.client?.name,
						technicians: r.visit_techs.map((t) => t.tech.name),
					}),
				),
				total,
			};
		},
	},

	// ── Quote ───────────────────────────────────────────────────────────
	quote: {
		async get(db, id) {
			const r = await db.quote.findFirst({
				where: { id },
				select: {
					id: true,
					quote_number: true,
					title: true,
					description: true,
					status: true,
					priority: true,
					address: true,
					version: true,
					subtotal: true,
					tax_amount: true,
					discount_amount: true,
					total: true,
					created_at: true,
					sent_at: true,
					approved_at: true,
					rejected_at: true,
					rejection_reason: true,
					valid_until: true,
					expires_at: true,
					client: clientRef,
					request: { select: { id: true, title: true } },
					job: { select: { id: true, job_number: true } },
					line_items: {
						select: { id: true, name: true, quantity: true, unit_price: true, total: true, item_type: true },
						orderBy: { sort_order: "asc" },
						take: 100,
					},
				},
			});
			if (!r) return null;
			return compact({
				id: r.id,
				type: "quote",
				quote_number: r.quote_number,
				title: r.title,
				description: clip(r.description),
				status: r.status,
				priority: r.priority,
				address: r.address,
				version: r.version,
				client: r.client,
				request: r.request ?? undefined,
				job: r.job ?? undefined,
				subtotal: money(r.subtotal),
				tax_amount: money(r.tax_amount),
				discount_amount: money(r.discount_amount),
				total: money(r.total),
				created_at: iso(r.created_at),
				sent_at: iso(r.sent_at),
				approved_at: iso(r.approved_at),
				rejected_at: iso(r.rejected_at),
				rejection_reason: r.rejection_reason ?? undefined,
				valid_until: iso(r.valid_until),
				expires_at: iso(r.expires_at),
				line_items: r.line_items.map((l) =>
					compact({
						id: l.id,
						name: l.name,
						quantity: money(l.quantity),
						unit_price: money(l.unit_price),
						total: money(l.total),
						item_type: l.item_type ?? undefined,
					}),
				),
			});
		},
		async list(db, f) {
			const where: Prisma.quoteWhereInput = compact({
				status: f.status as Prisma.quoteWhereInput["status"],
				client_id: f.clientId,
				created_at: dateRange(f),
			});
			const [rows, total] = await Promise.all([
				db.quote.findMany({
					where,
					select: {
						id: true,
						quote_number: true,
						title: true,
						status: true,
						total: true,
						created_at: true,
						expires_at: true,
						client: clientRef,
					},
					orderBy: { created_at: "desc" },
					take: f.limit,
				}),
				db.quote.count({ where }),
			]);
			return {
				rows: rows.map((r) =>
					compact({
						id: r.id,
						quote_number: r.quote_number,
						title: r.title,
						status: r.status,
						total: money(r.total),
						client: r.client?.name,
						created_at: iso(r.created_at),
						expires_at: iso(r.expires_at),
					}),
				),
				total,
			};
		},
	},

	// ── Request ─────────────────────────────────────────────────────────
	request: {
		async get(db, id) {
			const r = await db.request.findFirst({
				where: { id },
				select: {
					id: true,
					title: true,
					description: true,
					status: true,
					priority: true,
					address: true,
					source: true,
					requires_quote: true,
					estimated_value: true,
					created_at: true,
					cancellation_reason: true,
					client: clientRef,
					quotes: { select: { id: true, quote_number: true, status: true }, take: 10 },
					jobs: { select: { id: true, job_number: true, status: true }, take: 10 },
				},
			});
			if (!r) return null;
			return compact({
				id: r.id,
				type: "request",
				title: r.title,
				description: clip(r.description, 1000),
				status: r.status,
				priority: r.priority,
				address: r.address ?? undefined,
				source: r.source ?? undefined,
				requires_quote: r.requires_quote,
				estimated_value: money(r.estimated_value),
				created_at: iso(r.created_at),
				cancellation_reason: r.cancellation_reason ?? undefined,
				client: r.client,
				quotes: r.quotes,
				jobs: r.jobs,
			});
		},
		async list(db, f) {
			const where: Prisma.requestWhereInput = compact({
				status: f.status as Prisma.requestWhereInput["status"],
				client_id: f.clientId,
				created_at: dateRange(f),
			});
			const [rows, total] = await Promise.all([
				db.request.findMany({
					where,
					select: {
						id: true,
						title: true,
						status: true,
						priority: true,
						created_at: true,
						client: clientRef,
					},
					orderBy: { created_at: "desc" },
					take: f.limit,
				}),
				db.request.count({ where }),
			]);
			return {
				rows: rows.map((r) =>
					compact({
						id: r.id,
						title: r.title,
						status: r.status,
						priority: r.priority,
						client: r.client?.name,
						created_at: iso(r.created_at),
					}),
				),
				total,
			};
		},
	},

	// ── Invoice ─────────────────────────────────────────────────────────
	invoice: {
		async get(db, id) {
			const r = await db.invoice.findFirst({
				where: { id },
				select: {
					id: true,
					invoice_number: true,
					status: true,
					issue_date: true,
					due_date: true,
					subtotal: true,
					tax_amount: true,
					discount_amount: true,
					total: true,
					amount_paid: true,
					balance_due: true,
					memo: true,
					created_at: true,
					paid_at: true,
					voided_at: true,
					void_reason: true,
					client: clientRef,
					line_items: {
						select: { id: true, name: true, quantity: true, unit_price: true, total: true },
						orderBy: { sort_order: "asc" },
						take: 100,
					},
					payments: { select: { id: true, amount: true, paid_at: true, method: true }, take: 25 },
				},
			});
			if (!r) return null;
			return compact({
				id: r.id,
				type: "invoice",
				invoice_number: r.invoice_number,
				status: r.status,
				client: r.client,
				issue_date: iso(r.issue_date),
				due_date: iso(r.due_date),
				subtotal: money(r.subtotal),
				tax_amount: money(r.tax_amount),
				discount_amount: money(r.discount_amount),
				total: money(r.total),
				amount_paid: money(r.amount_paid),
				balance_due: money(r.balance_due),
				memo: clip(r.memo),
				created_at: iso(r.created_at),
				paid_at: iso(r.paid_at),
				voided_at: iso(r.voided_at),
				void_reason: r.void_reason ?? undefined,
				line_items: r.line_items.map((l) =>
					compact({
						id: l.id,
						name: l.name,
						quantity: money(l.quantity),
						unit_price: money(l.unit_price),
						total: money(l.total),
					}),
				),
				payments: r.payments.map((p) =>
					compact({ id: p.id, amount: money(p.amount), paid_at: iso(p.paid_at), method: p.method }),
				),
			});
		},
		async list(db, f) {
			const where: Prisma.invoiceWhereInput = compact({
				status: f.status as Prisma.invoiceWhereInput["status"],
				client_id: f.clientId,
				created_at: dateRange(f),
			});
			const [rows, total] = await Promise.all([
				db.invoice.findMany({
					where,
					select: {
						id: true,
						invoice_number: true,
						status: true,
						total: true,
						balance_due: true,
						due_date: true,
						client: clientRef,
					},
					orderBy: { created_at: "desc" },
					take: f.limit,
				}),
				db.invoice.count({ where }),
			]);
			return {
				rows: rows.map((r) =>
					compact({
						id: r.id,
						invoice_number: r.invoice_number,
						status: r.status,
						total: money(r.total),
						balance_due: money(r.balance_due),
						due_date: iso(r.due_date),
						client: r.client?.name,
					}),
				),
				total,
			};
		},
	},

	// ── Project ─────────────────────────────────────────────────────────
	project: {
		async get(db, id) {
			const r = await db.project.findFirst({
				where: { id },
				select: {
					id: true,
					project_number: true,
					name: true,
					description: true,
					status: true,
					priority: true,
					address: true,
					budget: true,
					starts_at: true,
					target_end_at: true,
					completed_at: true,
					client: clientRef,
					manager_dispatcher: { select: { id: true, name: true } },
					jobs: { select: { id: true, job_number: true, name: true, status: true }, take: 50 },
				},
			});
			if (!r) return null;
			return compact({
				id: r.id,
				type: "project",
				project_number: r.project_number,
				name: r.name,
				description: clip(r.description),
				status: r.status,
				priority: r.priority,
				address: r.address ?? undefined,
				budget: money(r.budget),
				starts_at: iso(r.starts_at),
				target_end_at: iso(r.target_end_at),
				completed_at: iso(r.completed_at),
				client: r.client,
				manager: r.manager_dispatcher ?? undefined,
				jobs: r.jobs,
			});
		},
		async list(db, f) {
			const where: Prisma.projectWhereInput = compact({
				status: f.status as Prisma.projectWhereInput["status"],
				client_id: f.clientId,
				created_at: dateRange(f),
			});
			const [rows, total] = await Promise.all([
				db.project.findMany({
					where,
					select: {
						id: true,
						project_number: true,
						name: true,
						status: true,
						target_end_at: true,
						client: clientRef,
					},
					orderBy: { created_at: "desc" },
					take: f.limit,
				}),
				db.project.count({ where }),
			]);
			return {
				rows: rows.map((r) =>
					compact({
						id: r.id,
						project_number: r.project_number,
						name: r.name,
						status: r.status,
						target_end_at: iso(r.target_end_at),
						client: r.client?.name,
					}),
				),
				total,
			};
		},
	},

	// ── Recurring plan ──────────────────────────────────────────────────
	recurring_plan: {
		async get(db, id) {
			const r = await db.recurring_plan.findFirst({
				where: { id },
				select: {
					id: true,
					name: true,
					description: true,
					status: true,
					priority: true,
					address: true,
					starts_at: true,
					ends_at: true,
					timezone: true,
					billing_mode: true,
					invoice_timing: true,
					auto_invoice: true,
					client: clientRef,
					job_container: { select: { id: true, job_number: true } },
					occurrences: {
						select: { id: true, occurrence_start_at: true, status: true },
						orderBy: { occurrence_start_at: "asc" },
						where: { status: "planned" },
						take: 10,
					},
					_count: { select: { occurrences: true, line_items: true } },
				},
			});
			if (!r) return null;
			return compact({
				id: r.id,
				type: "recurring_plan",
				name: r.name,
				description: clip(r.description),
				status: r.status,
				priority: r.priority,
				address: r.address,
				starts_at: iso(r.starts_at),
				ends_at: iso(r.ends_at),
				timezone: r.timezone,
				billing_mode: r.billing_mode,
				invoice_timing: r.invoice_timing,
				auto_invoice: r.auto_invoice,
				client: r.client,
				job: r.job_container ?? undefined,
				// Next 10 planned occurrences only — the full series can run for years.
				upcoming_occurrences: r.occurrences.map((o) =>
					compact({ id: o.id, starts_at: iso(o.occurrence_start_at), status: o.status }),
				),
				counts: r._count,
			});
		},
		async list(db, f) {
			const where: Prisma.recurring_planWhereInput = compact({
				status: f.status as Prisma.recurring_planWhereInput["status"],
				client_id: f.clientId,
				starts_at: dateRange(f),
			});
			const [rows, total] = await Promise.all([
				db.recurring_plan.findMany({
					where,
					select: {
						id: true,
						name: true,
						status: true,
						starts_at: true,
						ends_at: true,
						client: clientRef,
					},
					orderBy: { starts_at: "desc" },
					take: f.limit,
				}),
				db.recurring_plan.count({ where }),
			]);
			return {
				rows: rows.map((r) =>
					compact({
						id: r.id,
						name: r.name,
						status: r.status,
						starts_at: iso(r.starts_at),
						ends_at: iso(r.ends_at),
						client: r.client?.name,
					}),
				),
				total,
			};
		},
	},

	// ── Technician ──────────────────────────────────────────────────────
	// `password` and the reset-token columns are omitted globally by the Prisma
	// client (SECRET_FIELD_OMIT in db.ts); the explicit selects below never ask
	// for them regardless.
	technician: {
		async get(db, id) {
			const r = await db.technician.findFirst({
				where: { id },
				select: {
					id: true,
					name: true,
					email: true,
					phone: true,
					title: true,
					status: true,
					hire_date: true,
					current_vehicle: { select: { id: true, name: true } },
					organization_role: { select: { id: true, name: true } },
				},
			});
			if (!r) return null;
			return compact({
				id: r.id,
				type: "technician",
				name: r.name,
				email: r.email,
				phone: r.phone,
				title: r.title,
				status: r.status,
				hire_date: iso(r.hire_date),
				vehicle: r.current_vehicle ?? undefined,
				role: r.organization_role?.name,
			});
		},
		async list(db, f) {
			const where: Prisma.technicianWhereInput = {
				...compact({ status: f.status as Prisma.technicianWhereInput["status"] }),
				deactivated_at: null,
			};
			const [rows, total] = await Promise.all([
				db.technician.findMany({
					where,
					select: { id: true, name: true, title: true, status: true, current_vehicle: { select: { name: true } } },
					orderBy: { name: "asc" },
					take: f.limit,
				}),
				db.technician.count({ where }),
			]);
			return {
				rows: rows.map((r) =>
					compact({
						id: r.id,
						name: r.name,
						title: r.title,
						status: r.status,
						vehicle: r.current_vehicle?.name,
					}),
				),
				total,
			};
		},
	},

	// ── Inventory item ──────────────────────────────────────────────────
	inventory_item: {
		async get(db, id) {
			const r = await db.inventory_item.findFirst({
				where: { id },
				select: {
					id: true,
					name: true,
					description: true,
					sku: true,
					barcode: true,
					location: true,
					quantity: true,
					unit: true,
					unit_price: true,
					cost: true,
					low_stock_threshold: true,
					category: true,
					is_active: true,
					is_serialized: true,
					is_batch_tracked: true,
				},
			});
			if (!r) return null;
			return compact({
				id: r.id,
				type: "inventory_item",
				name: r.name,
				description: clip(r.description),
				sku: r.sku ?? undefined,
				barcode: r.barcode ?? undefined,
				location: r.location,
				quantity: money(r.quantity),
				unit: r.unit,
				unit_price: money(r.unit_price),
				cost: money(r.cost),
				low_stock_threshold: money(r.low_stock_threshold),
				category: r.category ?? undefined,
				is_active: r.is_active,
				is_serialized: r.is_serialized,
				is_batch_tracked: r.is_batch_tracked,
			});
		},
		async list(db, f) {
			const where: Prisma.inventory_itemWhereInput = { is_active: true };
			const [rows, total] = await Promise.all([
				db.inventory_item.findMany({
					where,
					select: {
						id: true,
						name: true,
						sku: true,
						quantity: true,
						unit: true,
						location: true,
						low_stock_threshold: true,
					},
					orderBy: { name: "asc" },
					take: f.limit,
				}),
				db.inventory_item.count({ where }),
			]);
			return {
				rows: rows.map((r) =>
					compact({
						id: r.id,
						name: r.name,
						sku: r.sku ?? undefined,
						quantity: money(r.quantity),
						unit: r.unit,
						location: r.location,
						low_stock_threshold: money(r.low_stock_threshold),
					}),
				),
				total,
			};
		},
	},
};
