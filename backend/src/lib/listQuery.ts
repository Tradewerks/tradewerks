import type { Request, Response } from "express";
import {
	createErrorResponse,
	createSuccessResponse,
	ErrorCodes,
} from "../types/responses.js";

/**
 * Shared list-endpoint contract. A request with `page` gets one page plus the
 * total in meta.count; one without keeps the old full-array shape so existing
 * callers keep working while they migrate (see markLegacyList).
 */

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
const MIN_SEARCH = 2;
const MAX_OFFSET = 2_147_483_647;

export interface ListSpec<S extends string, St extends string> {
	sortable: readonly S[];
	defaultSort: S;
	defaultDir: "asc" | "desc";
	statuses?: readonly St[];
}

export interface ParsedList<S, St> {
	paged: boolean;
	skip: number;
	take: number;
	page: number;
	sort: S;
	dir: "asc" | "desc";
	q?: string;
	status?: St[];
	from?: Date;
	to?: Date;
}

// statusCode + code let the global error handler answer it as a 400 if a
// controller lets it propagate instead of catching it.
export class ListQueryError extends Error {
	readonly statusCode = 400;
	readonly code = ErrorCodes.INVALID_INPUT;
	constructor(
		readonly field: string,
		message: string,
	) {
		super(message);
		this.name = "ListQueryError";
	}
}

type Query = Request["query"];

function single(query: Query, field: string): string | undefined {
	const v = query[field];
	if (v === undefined) return undefined;
	if (typeof v !== "string") {
		throw new ListQueryError(field, `${field} must be given once`);
	}
	return v;
}

function positiveInt(query: Query, field: string, fallback: number): number {
	const raw = single(query, field);
	// `?page` with no value is a paged request for the first page.
	if (raw === undefined || raw === "") return fallback;
	if (!/^\d+$/.test(raw) || Number(raw) < 1) {
		throw new ListQueryError(
			field,
			`${field} must be a whole number of at least 1`,
		);
	}
	return Number(raw);
}

// Date-only or full ISO; a bare Date.parse would accept "1" or "March".
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

function isoDate(query: Query, field: string): Date | undefined {
	const raw = single(query, field)?.trim();
	if (!raw) return undefined;
	const d = new Date(raw);
	if (!ISO_DATE.test(raw) || Number.isNaN(d.getTime())) {
		throw new ListQueryError(field, `${field} must be an ISO date`);
	}
	return d;
}

export function parseListQuery<S extends string, St extends string>(
	query: Query,
	spec: ListSpec<S, St>,
): ParsedList<S, St> {
	const paged = "page" in query;
	const page = positiveInt(query, "page", 1);
	const take = positiveInt(query, "limit", DEFAULT_LIMIT);
	if (take > MAX_LIMIT) {
		throw new ListQueryError("limit", `limit must be at most ${MAX_LIMIT}`);
	}
	// Prisma's skip is an int32; a larger offset makes it throw, turning client
	// input into a 500.
	if ((page - 1) * take > MAX_OFFSET) {
		throw new ListQueryError("page", "page is past the end of any list");
	}

	const sortRaw = single(query, "sort");
	let sort = spec.defaultSort;
	if (sortRaw) {
		if (!(spec.sortable as readonly string[]).includes(sortRaw)) {
			throw new ListQueryError(
				"sort",
				`sort must be one of: ${spec.sortable.join(", ")}`,
			);
		}
		sort = sortRaw as S;
	}

	const dirRaw = single(query, "dir");
	let dir = spec.defaultDir;
	if (dirRaw) {
		if (dirRaw !== "asc" && dirRaw !== "desc") {
			throw new ListQueryError("dir", "dir must be asc or desc");
		}
		dir = dirRaw;
	}

	const qRaw = single(query, "q")?.trim();
	const q = qRaw && qRaw.length >= MIN_SEARCH ? qRaw : undefined;

	let status: St[] | undefined;
	const statusRaw = single(query, "status");
	if (statusRaw) {
		const allowed = (spec.statuses ?? []) as readonly string[];
		const parts = statusRaw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const bad = parts.find((s) => !allowed.includes(s));
		if (bad !== undefined) {
			throw new ListQueryError(
				"status",
				allowed.length
					? `status must be among: ${allowed.join(", ")}`
					: "this list has no status filter",
			);
		}
		status = parts.length ? (parts as St[]) : undefined;
	}

	const from = isoDate(query, "from");
	const to = isoDate(query, "to");
	if (from && to && from > to) {
		throw new ListQueryError("to", "to must not be before from");
	}

	return {
		paged,
		page,
		take,
		skip: (page - 1) * take,
		sort,
		dir,
		q,
		status,
		from,
		to,
	};
}

export function markLegacyList(res: Response): void {
	let target = "?page=1";
	const original = res.req?.originalUrl;
	if (original) {
		const url = new URL(original, "http://x");
		url.searchParams.set("page", "1");
		target = url.pathname + url.search;
	}
	res.setHeader("Deprecation", "true");
	res.setHeader("Link", `<${target}>; rel="successor-version"`);
}

export function sendList<T>(
	res: Response,
	parsed: ParsedList<unknown, unknown>,
	rows: T[],
	total: number,
): void {
	if (!parsed.paged) {
		markLegacyList(res);
		res.json(createSuccessResponse(rows, { count: total }));
		return;
	}
	res.json(
		createSuccessResponse(rows, {
			count: total,
			page: parsed.page,
			limit: parsed.take,
		}),
	);
}

// Answering here keeps `field` in the body (the global handler drops it) and
// keeps a client mistake out of the error-level log.
export function sendListError(res: Response, err: unknown): boolean {
	if (!(err instanceof ListQueryError)) return false;
	res.status(400).json(
		createErrorResponse(err.code, err.message, undefined, err.field),
	);
	return true;
}
