import { getScopedDb } from "./context.js";

export type LineageKind = "quote" | "invoice";

/** One document in a lineage, reduced to what the band renders. */
export interface LineageNode {
	id: string;
	number: string;
	version: number;
	status: string;
}

export interface DocumentLineage {
	self_id: string;
	/** The numerator in "Version 2 of 6". */
	self_version: number;
	/**
	 * The denominator. Taken from the TAIL's version, not from chain.length:
	 * deleting the head of a chain SetNulls the next document's pointer, so the
	 * resolved row count understates the real depth while the tail's version
	 * does not.
	 */
	latest_version: number;
	/** Every resolved hop, ascending. Always contains the viewed document. */
	chain: LineageNode[];
	/** Oldest resolved hop is not version 1 — earlier documents were deleted. */
	truncated_before: boolean;
	/** The next hop, or null when the viewed document is the tail. */
	successor: LineageNode | null;
	/** The tail. Equals the viewed document when it IS the tail, never null. */
	final: LineageNode;
	/** False when the tail sits in a terminal status: the band then says "Latest". */
	final_is_live: boolean;
	/** Invoice only — the document this one amends. */
	adjusts: LineageNode | null;
	/** Invoice only — amendments written against this document. */
	adjustments: LineageNode[];
}

/**
 * A tail in one of these is not the authoritative document, so the band labels
 * it "Latest version" rather than "Current version". Kept per kind: "Cancelled"
 * is terminal for a quote and is not an invoice status at all, and one merged
 * list would wrongly kill a live invoice whose status happened to collide.
 */
const TERMINAL_STATUSES: Record<LineageKind, readonly string[]> = {
	quote: ["Cancelled", "Rejected", "Expired", "Revised"],
	invoice: ["Void"],
};

/**
 * Pure shaping, split out from the query so every branch of decision 5 is
 * testable without a database.
 */
export function shapeLineage(
	kind: LineageKind,
	selfId: string,
	rows: LineageNode[],
	adjusts: LineageNode | null,
	adjustments: LineageNode[],
): DocumentLineage | null {
	// The CTE has no ORDER BY — a top-level UNION with one would constrain how
	// the branches are written for no gain. Sorting here also keeps the shaping
	// tests independent of query text.
	const chain = [...rows].sort((a, b) => a.version - b.version);
	const selfIndex = chain.findIndex((n) => n.id === selfId);
	if (selfIndex === -1) return null;

	const self = chain[selfIndex]!;
	const final = chain[chain.length - 1]!;

	return {
		self_id: self.id,
		self_version: self.version,
		latest_version: final.version,
		chain,
		truncated_before: chain[0]!.version > 1,
		successor: chain[selfIndex + 1] ?? null,
		final,
		final_is_live: !TERMINAL_STATUSES[kind].includes(final.status),
		adjusts,
		adjustments,
	};
}

/**
 * Walks a document's revision chain to both ends and returns everything the
 * lineage band needs, or null when the document does not exist.
 *
 * One recursive CTE per direction, unioned, so the whole chain arrives in a
 * single round trip along with its depth — an iterative walk would cost one
 * query per hop and still need its own cycle guard.
 *
 * SECURITY: getScopedDb's extension rewrites `where` clauses on model
 * operations and does NOT reach $queryRaw. Every term below carries its own
 * organization_id predicate; removing one lets an organization walk another's
 * chain. The `depth < 50` guard is not decoration either — previous_*_id being
 * @unique does not stop a row from pointing at itself.
 */
export async function resolveDocumentLineage(
	kind: LineageKind,
	id: string,
	organizationId: string,
): Promise<DocumentLineage | null> {
	const sdb = getScopedDb(organizationId);

	// Table and column names cannot be parameterized, so the two kinds get two
	// literal queries. Everything downstream of `rows` is shared.
	const rows =
		kind === "quote"
			? await sdb.$queryRaw<LineageNode[]>`
				WITH RECURSIVE ancestors AS (
					SELECT id, quote_number AS "number", version,
					       status::text AS status, previous_quote_id,
					       0 AS depth
					  FROM quote
					 WHERE id = ${id}
					   AND organization_id = ${organizationId}
					UNION ALL
					SELECT q.id, q.quote_number, q.version,
					       q.status::text, q.previous_quote_id,
					       a.depth + 1
					  FROM quote q
					  JOIN ancestors a ON q.id = a.previous_quote_id
					 WHERE q.organization_id = ${organizationId}
					   AND a.depth < 50
				), descendants AS (
					SELECT id, quote_number AS "number", version,
					       status::text AS status, previous_quote_id,
					       0 AS depth
					  FROM quote
					 WHERE id = ${id}
					   AND organization_id = ${organizationId}
					UNION ALL
					SELECT q.id, q.quote_number, q.version,
					       q.status::text, q.previous_quote_id,
					       d.depth + 1
					  FROM quote q
					  JOIN descendants d ON q.previous_quote_id = d.id
					 WHERE q.organization_id = ${organizationId}
					   AND d.depth < 50
				)
				SELECT id, "number", version, status FROM ancestors
				UNION
				SELECT id, "number", version, status FROM descendants
			`
			: await sdb.$queryRaw<LineageNode[]>`
				WITH RECURSIVE ancestors AS (
					SELECT id, invoice_number AS "number", version,
					       status::text AS status, previous_invoice_id,
					       0 AS depth
					  FROM invoice
					 WHERE id = ${id}
					   AND organization_id = ${organizationId}
					UNION ALL
					SELECT i.id, i.invoice_number, i.version,
					       i.status::text, i.previous_invoice_id,
					       a.depth + 1
					  FROM invoice i
					  JOIN ancestors a ON i.id = a.previous_invoice_id
					 WHERE i.organization_id = ${organizationId}
					   AND a.depth < 50
				), descendants AS (
					SELECT id, invoice_number AS "number", version,
					       status::text AS status, previous_invoice_id,
					       0 AS depth
					  FROM invoice
					 WHERE id = ${id}
					   AND organization_id = ${organizationId}
					UNION ALL
					SELECT i.id, i.invoice_number, i.version,
					       i.status::text, i.previous_invoice_id,
					       d.depth + 1
					  FROM invoice i
					  JOIN descendants d ON i.previous_invoice_id = d.id
					 WHERE i.organization_id = ${organizationId}
					   AND d.depth < 50
				)
				SELECT id, "number", version, status FROM ancestors
				UNION
				SELECT id, "number", version, status FROM descendants
			`;

	if (kind === "quote") return shapeLineage(kind, id, rows, null, []);

	// The adjustment axis is a fan, not a chain, so it needs no recursion — two
	// scoped reads. invoiceInclude already carries these relations, but only as
	// { id, invoice_number }: the band needs version and status too, and
	// widening that include would change five list call sites for no gain.
	const [self, children] = await Promise.all([
		sdb.invoice.findFirst({
			where: { id },
			select: {
				adjusts_invoice: {
					select: {
						id: true,
						invoice_number: true,
						version: true,
						status: true,
					},
				},
			},
		}),
		sdb.invoice.findMany({
			where: { adjusts_invoice_id: id },
			select: {
				id: true,
				invoice_number: true,
				version: true,
				status: true,
			},
			orderBy: { invoice_number: "asc" },
		}),
	]);

	const toNode = (r: {
		id: string;
		invoice_number: string;
		version: number;
		status: string;
	}): LineageNode => ({
		id: r.id,
		number: r.invoice_number,
		version: r.version,
		status: r.status,
	});

	return shapeLineage(
		kind,
		id,
		rows,
		self?.adjusts_invoice ? toNode(self.adjusts_invoice) : null,
		children.map(toNode),
	);
}
