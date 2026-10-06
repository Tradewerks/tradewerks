/**
 * Cross-entity search.
 *
 * Written for the agent, but not agent-specific: the dispatcher UI's global
 * search currently loads every client, job, quote, request, visit, plan and
 * technician into the browser and filters locally (see
 * `frontend/src/components/nav/GlobalSearch.tsx`). That works at demo scale and
 * will not survive a real org — and an agent cannot do it at all, since it has
 * no browser to hold the data in. Both callers want the same thing, so this is
 * a plain service with a REST route in front of it.
 *
 * Every query runs through `getScopedDb`, so tenancy is enforced by the same
 * extension the rest of the app relies on rather than by remembering to add a
 * filter here.
 */

import { ENTITY_MODULE, namesWithModuleOn } from "../lib/entitlements/ownership.js";
import { getScopedDb } from "../lib/context.js";

export const SEARCHABLE_TYPES = [
	"client",
	"job",
	"quote",
	"request",
	"invoice",
	"visit",
	"technician",
	"contact",
	"project",
	"inventory_item",
] as const;

export type SearchEntityType = (typeof SEARCHABLE_TYPES)[number];

export interface SearchHit {
	id: string;
	type: SearchEntityType;
	/** Primary display string — the thing a person would recognise the record by. */
	label: string;
	/** Secondary context: client name, status, address. */
	sublabel?: string;
	status?: string;
	/** Deep link into the dispatcher UI, matching AppRoutes. */
	route: string;
}

export interface SearchOptions {
	query: string;
	/** Restrict to these types. Callers pass the subset the user may view. */
	types?: readonly SearchEntityType[];
	/** Hits per type, 1-50. Total results are at most limit × types.length. */
	limit?: number;
}

export interface SearchOutcome {
	hits: SearchHit[];
	/** True when at least one type filled its limit — there may be more. */
	truncated: boolean;
	types: SearchEntityType[];
}

export const MIN_QUERY_LENGTH = 2;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;

/**
 * Which permission lets a caller see a type at all.
 *
 * ANY-OF per type, matching `requireAnyPermission`. Kept here rather than in the
 * route so the agent tool and the REST endpoint cannot disagree about who may
 * see what — a search that quietly returns rows the caller could not open by
 * navigating to them is a permission leak with extra steps.
 */
export const SEARCH_TYPE_PERMISSIONS: Record<SearchEntityType, readonly string[]> = {
	client: ["view_clients"],
	job: ["view_jobs", "view_assigned_jobs", "view_all_jobs"],
	quote: ["view_quotes"],
	request: ["view_requests"],
	invoice: ["view_invoices"],
	visit: ["view_jobs", "view_visits", "view_all_jobs", "view_assigned_jobs"],
	technician: ["view_technicians", "view_team_schedule"],
	contact: ["view_clients"],
	project: ["view_projects"],
	inventory_item: ["view_inventory"],
};

/** The subset of types these permissions may search. */
export function allowedSearchTypes(permissions: Iterable<string>): SearchEntityType[] {
	const held = new Set(permissions);
	return SEARCHABLE_TYPES.filter((type) => SEARCH_TYPE_PERMISSIONS[type].some((p) => held.has(p)));
}

type ScopedDb = ReturnType<typeof getScopedDb>;

/** Case-insensitive substring match, the same predicate `searchContacts` uses. */
const like = (q: string) => ({ contains: q, mode: "insensitive" as const });

/** Drop empty sublabel segments so a hit never reads "Acme ·  · ". */
const join = (...parts: Array<string | null | undefined>) => {
	const kept = parts.filter((p): p is string => !!p && p.trim().length > 0);
	return kept.length ? kept.join(" · ") : undefined;
};

type Searcher = (db: ScopedDb, q: string, take: number) => Promise<SearchHit[]>;

const SEARCHERS: Record<SearchEntityType, Searcher> = {
	client: async (db, q, take) => {
		const rows = await db.client.findMany({
			where: { OR: [{ name: like(q) }, { address: like(q) }] },
			select: { id: true, name: true, address: true, is_active: true },
			orderBy: { last_activity: "desc" },
			take,
		});
		return rows.map((r) => ({
			id: r.id,
			type: "client" as const,
			label: r.name,
			sublabel: join(r.address, r.is_active ? undefined : "inactive"),
			route: `/dispatch/clients/${r.id}`,
		}));
	},

	job: async (db, q, take) => {
		const rows = await db.job.findMany({
			where: {
				OR: [{ job_number: like(q) }, { name: like(q) }, { description: like(q) }, { address: like(q) }],
			},
			select: {
				id: true,
				job_number: true,
				name: true,
				status: true,
				address: true,
				client: { select: { name: true } },
			},
			orderBy: { created_at: "desc" },
			take,
		});
		return rows.map((r) => ({
			id: r.id,
			type: "job" as const,
			label: `${r.job_number} — ${r.name}`,
			sublabel: join(r.client?.name, r.address),
			status: r.status,
			route: `/dispatch/jobs/${r.id}`,
		}));
	},

	quote: async (db, q, take) => {
		const rows = await db.quote.findMany({
			where: {
				OR: [{ quote_number: like(q) }, { title: like(q) }, { description: like(q) }, { address: like(q) }],
			},
			select: {
				id: true,
				quote_number: true,
				title: true,
				status: true,
				client: { select: { name: true } },
			},
			orderBy: { created_at: "desc" },
			take,
		});
		return rows.map((r) => ({
			id: r.id,
			type: "quote" as const,
			label: `${r.quote_number} — ${r.title}`,
			sublabel: r.client?.name,
			status: r.status,
			route: `/dispatch/quotes/${r.id}`,
		}));
	},

	request: async (db, q, take) => {
		const rows = await db.request.findMany({
			where: { OR: [{ title: like(q) }, { description: like(q) }, { address: like(q) }] },
			select: {
				id: true,
				title: true,
				status: true,
				priority: true,
				client: { select: { name: true } },
			},
			orderBy: { created_at: "desc" },
			take,
		});
		return rows.map((r) => ({
			id: r.id,
			type: "request" as const,
			label: r.title,
			sublabel: join(r.client?.name, r.priority),
			status: r.status,
			route: `/dispatch/requests/${r.id}`,
		}));
	},

	invoice: async (db, q, take) => {
		const rows = await db.invoice.findMany({
			where: { OR: [{ invoice_number: like(q) }, { memo: like(q) }] },
			select: {
				id: true,
				invoice_number: true,
				status: true,
				total: true,
				client: { select: { name: true } },
			},
			orderBy: { created_at: "desc" },
			take,
		});
		return rows.map((r) => ({
			id: r.id,
			type: "invoice" as const,
			label: r.invoice_number,
			sublabel: join(r.client?.name, `$${Number(r.total).toFixed(2)}`),
			status: r.status,
			route: `/dispatch/invoices/${r.id}`,
		}));
	},

	visit: async (db, q, take) => {
		// job_visit has no organization_id of its own; getScopedDb pins it through
		// the parent job (RELATION_SCOPED_MODELS in lib/context.ts).
		const rows = await db.job_visit.findMany({
			where: {
				OR: [{ name: like(q) }, { description: like(q) }, { job: { job_number: like(q) } }],
			},
			select: {
				id: true,
				name: true,
				status: true,
				scheduled_start_at: true,
				job: { select: { id: true, job_number: true, client: { select: { name: true } } } },
			},
			orderBy: { scheduled_start_at: "desc" },
			take,
		});
		return rows.map((r) => ({
			id: r.id,
			type: "visit" as const,
			label: r.name ?? `Visit on ${r.job.job_number}`,
			sublabel: join(r.job.client?.name, r.scheduled_start_at.toISOString()),
			status: r.status,
			route: `/dispatch/jobs/${r.job.id}/visits/${r.id}`,
		}));
	},

	technician: async (db, q, take) => {
		const rows = await db.technician.findMany({
			where: { deactivated_at: null, OR: [{ name: like(q) }, { email: like(q) }, { title: like(q) }] },
			select: { id: true, name: true, email: true, title: true, status: true },
			orderBy: { name: "asc" },
			take,
		});
		return rows.map((r) => ({
			id: r.id,
			type: "technician" as const,
			label: r.name,
			sublabel: join(r.title, r.email),
			status: r.status,
			route: `/dispatch/technicians/${r.id}`,
		}));
	},

	contact: async (db, q, take) => {
		const rows = await db.contact.findMany({
			where: {
				is_active: true,
				OR: [{ name: like(q) }, { email: like(q) }, { phone: like(q) }],
			},
			select: {
				id: true,
				name: true,
				email: true,
				phone: true,
				client_contacts: { select: { client: { select: { id: true, name: true } } }, take: 1 },
			},
			orderBy: { name: "asc" },
			take,
		});
		return rows.map((r) => {
			const client = r.client_contacts[0]?.client;
			return {
				id: r.id,
				type: "contact" as const,
				label: r.name,
				sublabel: join(client?.name, r.email, r.phone),
				// Contacts have no page of their own — land on the client that owns them.
				route: client ? `/dispatch/clients/${client.id}` : "/dispatch/clients",
			};
		});
	},

	project: async (db, q, take) => {
		const rows = await db.project.findMany({
			where: {
				OR: [{ project_number: like(q) }, { name: like(q) }, { description: like(q) }],
			},
			select: {
				id: true,
				project_number: true,
				name: true,
				status: true,
				client: { select: { name: true } },
			},
			orderBy: { created_at: "desc" },
			take,
		});
		return rows.map((r) => ({
			id: r.id,
			type: "project" as const,
			label: `${r.project_number} — ${r.name}`,
			sublabel: r.client?.name,
			status: r.status,
			route: `/dispatch/projects/${r.id}`,
		}));
	},

	inventory_item: async (db, q, take) => {
		const rows = await db.inventory_item.findMany({
			where: {
				OR: [{ name: like(q) }, { sku: like(q) }, { barcode: like(q) }, { description: like(q) }],
			},
			select: {
				id: true,
				name: true,
				sku: true,
				quantity: true,
				unit: true,
				location: true,
				is_active: true,
			},
			orderBy: { name: "asc" },
			take,
		});
		return rows.map((r) => ({
			id: r.id,
			type: "inventory_item" as const,
			label: r.name,
			sublabel: join(r.sku, `${Number(r.quantity)} ${r.unit}`, r.location),
			status: r.is_active ? undefined : "inactive",
			route: `/dispatch/inventory/items/${r.id}`,
		}));
	},
};

/**
 * Search across entity types in one pass.
 *
 * Types run concurrently and are capped individually, so one noisy type cannot
 * crowd the others out of the result set — which matters more for an agent than
 * for a human, since the agent's whole view of the system is this list.
 */
export async function searchRecords(organizationId: string, options: SearchOptions): Promise<SearchOutcome> {
	const query = options.query.trim();
	// Filtered here, not in the route, so the assistant's search tool is covered too.
	const types = await namesWithModuleOn(
		organizationId,
		(options.types?.length ? options.types : SEARCHABLE_TYPES).filter(
			(t): t is SearchEntityType => t in SEARCHERS,
		),
		ENTITY_MODULE,
	);
	const limit = Math.min(Math.max(options.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);

	if (query.length < MIN_QUERY_LENGTH || !types.length) {
		return { hits: [], truncated: false, types: [...types] };
	}

	const db = getScopedDb(organizationId);
	const batches = await Promise.all(types.map((type) => SEARCHERS[type](db, query, limit)));

	return {
		hits: batches.flat(),
		truncated: batches.some((b) => b.length === limit),
		types: [...types],
	};
}

/** Exposed for the route layer to reject unknown `types` values with a clear message. */
export function isSearchableType(value: string): value is SearchEntityType {
	return value in SEARCHERS;
}
