import type { Request } from "express";
import { ListQueryError } from "./listQuery.js";

export const MAX_SEARCH_TERMS = 5;

// Whitespace-separated words, each of which must match somewhere in the row.
export function searchTerms(q: string | undefined): string[] {
	if (!q) return [];
	return q.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);
}

/**
 * AND across terms, OR across the columns one term is looked for in. Returns
 * undefined when there is nothing to search so callers can spread it away.
 */
export function andOfOrs<W>(
	q: string | undefined,
	columnClauses: (term: string) => W[],
): { AND: { OR: W[] }[] } | undefined {
	const terms = searchTerms(q);
	if (!terms.length) return undefined;
	return { AND: terms.map((term) => ({ OR: columnClauses(term) })) };
}

export const containsInsensitive = (term: string) => ({
	contains: term,
	mode: "insensitive" as const,
});

// A comma-separated list of enum values given once (?priority=High,Urgent).
export function enumListParam<V extends string>(
	query: Request["query"],
	field: string,
	values: readonly V[],
): V[] | undefined {
	const raw = query[field];
	if (raw === undefined) return undefined;
	if (typeof raw !== "string") {
		throw new ListQueryError(field, `${field} must be given once`);
	}
	const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
	if (!parts.length) return undefined;
	if (parts.some((p) => !(values as readonly string[]).includes(p))) {
		throw new ListQueryError(field, `${field} must be among: ${values.join(", ")}`);
	}
	return parts as V[];
}

// A string given once (?client_id=...), trimmed; empty counts as absent.
export function singleParam(query: Request["query"], field: string): string | undefined {
	const raw = query[field];
	if (raw === undefined) return undefined;
	if (typeof raw !== "string") {
		throw new ListQueryError(field, `${field} must be given once`);
	}
	return raw.trim() || undefined;
}
