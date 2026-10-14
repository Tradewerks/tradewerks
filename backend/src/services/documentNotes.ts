import type { Prisma } from "../../generated/prisma/client.js";
import type { UserContext } from "../lib/context.js";
import type { DisputeKind } from "./disputeAdapters.js";

/**
 * Shared pieces of "clone a document into a revision". Lives here rather than in
 * disputeService because both revision paths need them — the dispute outcome
 * and the standalone Create Revision — and importing from disputeService would
 * make the files circular.
 */

/** The note table and its document foreign key, per kind. */
const NOTE_TABLE: Record<
	DisputeKind,
	{ model: "quote_note" | "invoice_note"; fk: "quote_id" | "invoice_id" }
> = {
	quote: { model: "quote_note", fk: "quote_id" },
	invoice: { model: "invoice_note", fk: "invoice_id" },
};

/**
 * The line-item columns a revision copies verbatim, as one list. Both revisions
 * spread this; the invoice one then adds its own `source_job_id` /
 * `source_visit_id`. A new shared column added here reaches both paths instead
 * of being hand-added to one and missed by the other.
 */
export const REVISION_LINE_FIELDS = [
	"name",
	"description",
	"quantity",
	"unit_price",
	"total",
	"item_type",
	"sort_order",
	"tax_group_id",
	"taxable",
	"tax_amount",
	"inventory_item_id",
] as const;

export function pick<T extends object, K extends keyof T>(
	source: T,
	keys: readonly K[],
): Pick<T, K> {
	const out = {} as Pick<T, K>;
	for (const key of keys) out[key] = source[key];
	return out;
}

/**
 * Carries a document's notes onto its replacement.
 */
export async function copyDocumentNotes(
	tx: Prisma.TransactionClient,
	kind: DisputeKind,
	fromId: string,
	toId: string,
	context: UserContext,
) {
	const { model, fk } = NOTE_TABLE[kind];
	// Prisma types each delegate's args separately, so `tx[model]` is a union
	// whose findMany/createMany signatures don't unify. The rows are the same
	// shape either way — cast once here rather than keep two field lists that
	// could drift apart.
	const table = tx[model] as unknown as {
		findMany(args: {
			where: Record<string, string>;
			orderBy: { created_at: "asc" };
		}): Promise<{ organization_id: string | null; content: string }[]>;
		createMany(args: { data: Record<string, unknown>[] }): Promise<unknown>;
	};

	const notes = await table.findMany({
		where: { [fk]: fromId },
		orderBy: { created_at: "asc" },
	});
	if (notes.length === 0) return;
	await table.createMany({
		data: notes.map((n) => ({
			[fk]: toId,
			organization_id: n.organization_id,
			content: n.content,
			creator_dispatcher_id: context.dispatcherId ?? null,
		})),
	});
}
