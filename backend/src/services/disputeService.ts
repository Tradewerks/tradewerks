import type { Prisma } from "../../generated/prisma/client.js";
import type { invoice_status } from "../../generated/prisma/enums.js";
import { generateInvoiceNumber } from "../db.js";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { logActivity, type ChangeSet } from "./logger.js";
import { createAdjustmentInvoice } from "./invoiceAdjustment.js";
import { copyDocumentNotes, pick, REVISION_LINE_FIELDS } from "./documentNotes.js";
import { reviseQuote } from "./quoteRevision.js";
import {
	invoicePaidTotal,
	syncBilledAmounts,
	syncInvoicePaymentTotals,
} from "./invoiceService.js";
import { mirrorInvoiceVoidToQuickBooks } from "./qb/qbInvoices.js";
import {
	assertValidInvoiceTransition,
	assertValidQuoteTransition,
	DocumentRuleError,
} from "../lib/statusTransitions.js";
import {
	invoiceAdapter,
	quoteAdapter,
	soldJobReason,
	voidBlockedByAdjustmentReason,
	voidBlockedByPaymentReason,
	type ContestedLine,
	type DisputeKind,
	type DocumentAdapter,
	type DocumentShape,
	type Outcome,
} from "./disputeAdapters.js";
import type {
	OpenDisputeInput,
	ResolveDisputeInput,
} from "../lib/validate/disputes.js";
import {
	NO_DISPUTE_AUTHORITY,
	outcomeRefusal,
	type DisputeAuthz,
	type DisputeForbiddenReason,
} from "../lib/disputeAuthz.js";

const ADAPTERS: Partial<Record<DisputeKind, DocumentAdapter>> = {
	quote: quoteAdapter,
	invoice: invoiceAdapter,
};

/**
 * A refusal the caller lost a race for rather than got wrong: a second open
 * dispute, or a compare-and-swap another dispatcher already won. Spec 7.3 and
 * 10 want these as 409, not 422, so the routes discriminate on this flag —
 * a flag, not the message text, so rewording the copy cannot silently
 * downgrade the status code.
 */
export type DisputeConflict = { err: string; conflict: true };

const conflict = (err: string): DisputeConflict => ({ err, conflict: true });

/** activityFormat names a document by `_quote_number` / `_invoice_number`, as quote.updated and invoice.updated already write them. */
const documentNumberChange = (kind: DisputeKind, doc: DocumentShape): ChangeSet =>
	kind === "quote"
		? { _quote_number: { old: null, new: doc.quote_number ?? null } }
		: { _invoice_number: { old: null, new: doc.invoice_number ?? null } };

/**
 * Separation of duties keys on opened_by_dispatcher_id, where null means the
 * system opened the dispute and nobody is separated from it. A human caller who
 * is not a dispatcher would record null too — slipping that check for good, and
 * resolving with no resolver on the audit row. Dispute permissions belong to
 * the dispatcher tier and role payloads are validated against it, so any other
 * caller reaching here holds them by mistake.
 */
const officeStaffOnly = () => ({
	err: "Only office staff can open or resolve disputes.",
	forbidden: "not_office_staff" as const,
});

export const OPEN_DISPUTE_EXISTS = "This document already has an open dispute.";

export const NO_RESOLVE_PERMISSION =
	"You don't have permission to resolve disputes.";

const SELF_RESOLUTION =
	"You opened this dispute, so you can't also resolve it. Hand it to a colleague.";

/** Every outcome, in display order. Closed ones are reported, never omitted. */
const OUTCOMES: readonly Outcome[] = ["ReviseAndResend", "IssueAdjustment", "Repeal"];

export type DisputeRefusal = { err: string; forbidden?: DisputeForbiddenReason };

/** One outcome as the server judges it for this caller right now. */
export interface OutcomeState {
	id: Outcome;
	disabled: boolean;
	/** The refusal a submit would return, or null when the outcome is open. */
	reason: string | null;
}

/** Who is asking, as the dispute list needs to know it. */
export interface DisputeAccess {
	authz: DisputeAuthz;
	/** Holds resolve_disputes, the resolve route's own gate. */
	canResolve: boolean;
	dispatcherId: string | undefined;
}

function adapterFor(kind: DisputeKind): DocumentAdapter {
	const adapter = ADAPTERS[kind];
	if (!adapter) throw new Error(`No dispute adapter registered for ${kind}`);
	return adapter;
}

/**
 * Whether this document has an Open dispute row. The one query behind every
 * "is a dispute live right now?" check — openDispute's own pre-check, the kebab
 * PATCH on either kind, and the quote-to-job conversion.
 */
export async function hasOpenDispute(
	tx: Prisma.TransactionClient,
	kind: DisputeKind,
	documentId: string,
): Promise<boolean> {
	const row = await tx.document_dispute.findFirst({
		where: { [adapterFor(kind).foreignKey]: documentId, status: "Open" },
		select: { id: true },
	});
	return row != null;
}

/**
 * The refusal both kebab PATCH paths share when a status change is asked for
 * while a dispute is open: resolveDispute needs the document still Disputed and
 * both exits from Disputed are terminal, so moving it here would strand the
 * open row behind the one-open-dispute index. Null when nothing is open.
 */
export async function openDisputeStatusChangeRefusal(
	tx: Prisma.TransactionClient,
	kind: DisputeKind,
	documentId: string,
): Promise<string | null> {
	return (await hasOpenDispute(tx, kind, documentId))
		? `This ${kind} has an open dispute. Resolve the dispute before changing its status.`
		: null;
}

/** Why this document's status can't take a dispute, or null. Shared by the
 *  open door and the dispute list, so the disabled button and the refusal
 *  cannot word it differently. */
function disputableRefusal(adapter: DocumentAdapter, doc: DocumentShape): string | null {
	if (adapter.disputableStatuses.includes(doc.status)) return null;
	// "An Approved", "A Fully Paid" — the status is named as the badge shows it,
	// which for invoices is not the stored enum value.
	const label = (status: string) => adapter.statusLabels?.[status] ?? status;
	const shown = label(doc.status);
	const article = "AEIOU".includes(shown[0]) ? "An" : "A";
	const sources = adapter.disputableStatuses.map(label).join(", ");
	return `${article} ${shown} ${adapter.kind} can't be disputed. Disputes may be opened from: ${sources}.`;
}

/**
 * Why this caller may not resolve the dispute with this outcome, or null.
 *
 * The one producer of that answer: resolveDispute refuses with it and the
 * dispute list reports it per outcome, so a disabled option's reason is the
 * refusal a submit would return (Ruling P11). The order is the contract, most
 * specific truth first:
 *   1. The document moved out of Disputed. Cancelling or voiding one leaves the
 *      dispute Open, and both transition guards short-circuit on from === to,
 *      so without this a Void invoice is revived as a fresh Issued document
 *      and Repeal rewrites an already-dead document's reason.
 *   2. The document rules the outcome out. Telling someone they lack
 *      permission for something nobody may do teaches a rule that does not
 *      exist.
 *   3. The caller's grant for this outcome: concession, then invoice void.
 *   4. Separation of duties, which closes every outcome alike. A dispute with
 *      no recorded opener (a system-opened one) has nobody to be separated
 *      from.
 * The resolve_disputes route gate answers before any of it; see
 * describeOutcomes.
 */
export function outcomeRefusalFor(
	kind: DisputeKind,
	doc: DocumentShape,
	openedByDispatcherId: string | null,
	outcome: Outcome,
	authz: DisputeAuthz,
	dispatcherId: string | undefined,
): DisputeRefusal | null {
	if (doc.status !== "Disputed") {
		return {
			err: `This ${kind} is no longer Disputed — it moved to ${doc.status} while the dispute was open. Reload the ${kind} and try again.`,
		};
	}

	const adapter = adapterFor(kind);
	if (!adapter.availableOutcomes(doc).includes(outcome)) {
		return {
			err:
				adapter.unavailableReason(doc, outcome) ??
				`${outcome} is not available for this document.`,
		};
	}

	const withheld = outcomeRefusal(kind, outcome, authz);
	if (withheld) return { err: withheld, forbidden: "concession" };

	if (
		openedByDispatcherId &&
		openedByDispatcherId === dispatcherId &&
		!authz.canResolveOwn
	) {
		return { err: SELF_RESOLUTION, forbidden: "self_resolution" };
	}
	return null;
}

/** Every outcome for an open dispute, closed ones carrying their refusal. */
export function describeOutcomes(
	kind: DisputeKind,
	doc: DocumentShape,
	openedByDispatcherId: string | null,
	access: DisputeAccess,
): OutcomeState[] {
	return OUTCOMES.map((id) => {
		// The route gate refuses before the service is ever reached.
		const reason = !access.canResolve
			? NO_RESOLVE_PERMISSION
			: (outcomeRefusalFor(
					kind,
					doc,
					openedByDispatcherId,
					id,
					access.authz,
					access.dispatcherId,
				)?.err ?? null);
		return { id, disabled: reason !== null, reason };
	});
}

/**
 * The document's disputes, each open one with its outcomes judged for this
 * caller, plus why a new dispute can't be opened. The UI renders both rather
 * than re-deriving them from raw evidence, which is how its copies drifted
 * from the rules they mirrored.
 */
export async function listDisputesWithOutcomes(
	kind: DisputeKind,
	documentId: string,
	organizationId: string,
	access: DisputeAccess,
) {
	const adapter = adapterFor(kind);
	const sdb = getScopedDb(organizationId);
	const [doc, rows] = await Promise.all([
		adapter.load(
			sdb as unknown as Prisma.TransactionClient,
			documentId,
			organizationId,
		),
		sdb.document_dispute.findMany({
			where: { [adapter.foreignKey]: documentId },
			orderBy: { opened_at: "desc" },
			include: {
				opened_by_dispatcher: { select: { id: true, name: true } },
				resolved_by_dispatcher: { select: { id: true, name: true } },
			},
		}),
	]);

	const disputes = rows.map((row) => ({
		...row,
		outcomes:
			doc && row.status === "Open"
				? describeOutcomes(kind, doc, row.opened_by_dispatcher_id, access)
				: null,
	}));
	// Same order as openDispute: the status rule, then the one-open rule.
	const openRefusal = doc
		? (disputableRefusal(adapter, doc) ??
			(rows.some((row) => row.status === "Open") ? OPEN_DISPUTE_EXISTS : null))
		: null;

	// The two write-path refusals the lifecycle bar still needs but that no
	// outcome carries: Convert to Job (quote) and the kebab's Void (invoice).
	// insertJob refuses a sold quote with soldJobReason, and updateInvoice
	// refuses the kebab Void with voidBlockedByPayment/Adjustment in that
	// order — the same producers named here, so the bar reads the server's
	// sentence instead of keeping its own copy (DW-19).
	const soldRefusal = doc && kind === "quote" ? soldJobReason(doc) : null;
	const voidRefusal =
		doc && kind === "invoice"
			? (voidBlockedByPaymentReason(Number(doc.amount_paid ?? 0)) ??
				voidBlockedByAdjustmentReason(doc.adjustments ?? []))
			: null;

	return {
		disputes,
		open_refusal: openRefusal,
		sold_refusal: soldRefusal,
		void_refusal: voidRefusal,
	};
}

export const OPEN_DISPUTES_LIMIT = 50;

export interface OpenDisputeSummary {
	dispute_id: string;
	kind: DisputeKind;
	document_id: string;
	document_number: string;
	client: { id: string; name: string } | null;
	/** quote.total, or invoice.balance_due: the figure the AR "in dispute" footnote sums. */
	amount: number;
	/** Sum of the contested-line snapshot; null when the whole document is contested. */
	contested_amount: number | null;
	reason: string;
	opened_at: Date;
	opened_by: { id: string; name: string } | null;
	can_resolve: boolean;
}

export interface OpenDisputeList {
	items: OpenDisputeSummary[];
	counts: Record<DisputeKind, number>;
	total: number;
}

const contestedAmount = (snapshot: unknown): number | null => {
	if (!Array.isArray(snapshot) || snapshot.length === 0) return null;
	const sum = (snapshot as ContestedLine[]).reduce((acc, line) => acc + Number(line.total ?? 0), 0);
	return Math.round(sum * 100) / 100;
};

/**
 * Every Open dispute the caller may see, oldest first, across documents. The
 * dashboard widget and the client banner read this; `kinds` comes from
 * viewableDisputeKinds so a caller never lists a document they can't open.
 */
export async function listOpenDisputes(
	organizationId: string,
	kinds: readonly DisputeKind[],
	access: DisputeAccess,
	clientId?: string,
): Promise<OpenDisputeList> {
	if (kinds.length === 0) return { items: [], counts: { quote: 0, invoice: 0 }, total: 0 };

	const sdb = getScopedDb(organizationId);
	const whereFor = (only: readonly DisputeKind[]) => ({
		status: "Open" as const,
		document_kind: { in: [...only] },
		...(clientId
			? { OR: [{ quote: { client_id: clientId } }, { invoice: { client_id: clientId } }] }
			: {}),
	});
	const countOf = (kind: DisputeKind) =>
		kinds.includes(kind)
			? sdb.document_dispute.count({ where: whereFor([kind]) })
			: Promise.resolve(0);

	const [rows, quoteCount, invoiceCount] = await Promise.all([
		sdb.document_dispute.findMany({
			where: whereFor(kinds),
			// Disputes carry no deadline, so age is the only urgency there is.
			orderBy: { opened_at: "asc" },
			take: OPEN_DISPUTES_LIMIT,
			include: {
				quote: {
					select: {
						quote_number: true,
						total: true,
						client: { select: { id: true, name: true } },
					},
				},
				invoice: {
					select: {
						invoice_number: true,
						balance_due: true,
						client: { select: { id: true, name: true } },
					},
				},
				opened_by_dispatcher: { select: { id: true, name: true } },
			},
		}),
		countOf("quote"),
		countOf("invoice"),
	]);

	const items = await Promise.all(
		rows.map(async (row): Promise<OpenDisputeSummary> => {
			const kind = row.document_kind as DisputeKind;
			const documentId = (kind === "quote" ? row.quote_id : row.invoice_id) as string;
			const doc = await adapterFor(kind).load(
				sdb as unknown as Prisma.TransactionClient,
				documentId,
				organizationId,
			);
			// The same judgement DisputeStage renders, so "You can resolve" never
			// promises an outcome the detail page then shows disabled.
			const canResolve =
				doc !== null &&
				describeOutcomes(kind, doc, row.opened_by_dispatcher_id, access).some(
					(o) => !o.disabled,
				);
			return {
				dispute_id: row.id,
				kind,
				document_id: documentId,
				document_number:
					(kind === "quote" ? row.quote?.quote_number : row.invoice?.invoice_number) ?? "",
				client: (kind === "quote" ? row.quote?.client : row.invoice?.client) ?? null,
				amount: Number((kind === "quote" ? row.quote?.total : row.invoice?.balance_due) ?? 0),
				contested_amount: contestedAmount(row.contested_line_item_ids),
				reason: row.reason,
				opened_at: row.opened_at,
				opened_by: row.opened_by_dispatcher ?? null,
				can_resolve: canResolve,
			};
		}),
	);

	return {
		items,
		counts: { quote: quoteCount, invoice: invoiceCount },
		total: quoteCount + invoiceCount,
	};
}

/**
 * The write half of a dispute, per kind. Everything in openDispute and
 * resolveDispute that used to branch on `kind` again — set Disputed, repeal,
 * revise, which dispute-row column the replacement id lands in, and whether
 * the outcome voids an invoice (so the post-commit QuickBooks mirror runs) —
 * lives here, so a third kind can't compile while silently falling into the
 * invoice branch.
 *
 * Kept beside resolveDispute rather than on the DocumentAdapter object because
 * `revise` calls reviseQuote, and disputeAdapters.ts importing it would form a
 * cycle with quoteRevision.ts (which imports soldJobReason from disputeAdapters).
 */
interface DisputeWrites {
	setDisputed(
		tx: Prisma.TransactionClient,
		id: string,
		from: string,
	): Promise<void>;
	repeal(
		tx: Prisma.TransactionClient,
		doc: DocumentShape,
		note: string,
	): Promise<void>;
	revise(
		tx: Prisma.TransactionClient,
		doc: DocumentShape,
		organizationId: string,
		context: UserContext,
	): Promise<string>;
	replacementColumn: "replacement_quote_id" | "replacement_invoice_id";
	/** Repeal → Void and Revise → Void both apply only to invoices, and both
	 *  need the post-commit QuickBooks void. */
	voidsOriginalInvoice: boolean;
}

const WRITES: Record<DisputeKind, DisputeWrites> = {
	quote: {
		async setDisputed(tx, id, from) {
			assertValidQuoteTransition(from, "Disputed");
			await tx.quote.update({
				where: { id },
				data: { status: "Disputed" },
			});
		},
		repeal: (tx, doc, note) => repealQuote(tx, doc, note),
		revise: (tx, doc, orgId, ctx) => reviseQuote(tx, doc, orgId, ctx),
		replacementColumn: "replacement_quote_id",
		voidsOriginalInvoice: false,
	},
	invoice: {
		async setDisputed(tx, id, from) {
			assertValidInvoiceTransition(from, "Disputed");
			await tx.invoice.update({
				where: { id },
				data: { status: "Disputed" },
			});
		},
		repeal: (tx, doc, note) => voidInvoice(tx, doc, note),
		revise: (tx, doc, orgId, ctx) => reviseInvoice(tx, doc, orgId, ctx),
		replacementColumn: "replacement_invoice_id",
		voidsOriginalInvoice: true,
	},
};

export async function openDispute(
	kind: DisputeKind,
	documentId: string,
	input: OpenDisputeInput,
	organizationId: string,
	context: UserContext,
) {
	const adapter = adapterFor(kind);
	const sdb = getScopedDb(organizationId);
	if (!context.dispatcherId) return officeStaffOnly();

	// $transaction's callback param is the extension-scoped client, not the
	// generated Prisma.TransactionClient type — cast once so the rest of this
	// function (and the adapters, which are typed against the generated shape)
	// can be written normally. Mirrors invoiceService.ts's createInvoiceRecord.
	return await sdb.$transaction(async (rawTx) => {
		const tx = rawTx as unknown as Prisma.TransactionClient;
		const doc = await adapter.load(tx, documentId, organizationId);
		if (!doc) return { err: `${kind} not found` };

		const ineligible = disputableRefusal(adapter, doc);
		if (ineligible) return { err: ineligible };

		if (await hasOpenDispute(tx, kind, documentId)) {
			return conflict(OPEN_DISPUTE_EXISTS);
		}

		const contested = input.contested_line_item_ids ?? [];
		let contestedSnapshot: ContestedLine[] = [];
		if (contested.length > 0) {
			const byId = new Map(doc.line_items.map((li) => [li.id, li]));
			if (contested.some((id) => !byId.has(id))) {
				return {
					err: "One or more contested line items do not belong to this document.",
				};
			}
			// Snapshot name and total now, not just the id: a quote line has no
			// lock against being deleted later (unlike an invoice's, once
			// issued), and a bare id would then resolve to nothing (DW-69).
			contestedSnapshot = contested.map((id) => {
				const li = byId.get(id)!;
				return { id: li.id, name: li.name, total: Number(li.total) };
			});
		}

		const dispute = await tx.document_dispute.create({
			data: {
				organization_id: organizationId,
				document_kind: kind,
				[adapter.foreignKey]: documentId,
				status: "Open",
				reason: input.reason,
				contested_line_item_ids:
					contestedSnapshot.length > 0
						? (contestedSnapshot as unknown as Prisma.InputJsonValue)
						: undefined,
				status_at_open: doc.status,
				opened_by_dispatcher_id: context.dispatcherId ?? null,
				// resolved_at is stamped by Node, so opened_at is too: two clocks
				// in different zones could show a dispute resolved before it opened.
				opened_at: new Date(),
			},
		});

		await WRITES[kind].setDisputed(tx, documentId, doc.status);

		await logActivity({
			event_type: `${kind}.dispute_opened`,
			action: "updated",
			entity_type: kind,
			entity_id: documentId,
			organization_id: organizationId,
			actor_type: context.dispatcherId ? "dispatcher" : "system",
			actor_id: context.dispatcherId,
			reason: input.reason,
			changes: {
				status: { old: doc.status, new: "Disputed" },
				...documentNumberChange(kind, doc),
			},
			ip_address: context.ipAddress,
			user_agent: context.userAgent,
		});

		return dispute;
	});
}

export async function resolveDispute(
	kind: DisputeKind,
	documentId: string,
	disputeId: string,
	input: ResolveDisputeInput,
	organizationId: string,
	context: UserContext,
	// Defaults to no authority so a caller that forgets to pass it is refused
	// rather than waved through: the failure mode of a dropped argument has to
	// be a 403, not a write-off.
	authz: DisputeAuthz = NO_DISPUTE_AUTHORITY,
) {
	const adapter = adapterFor(kind);
	const sdb = getScopedDb(organizationId);
	if (!context.dispatcherId) return officeStaffOnly();

	// Filled inside the transaction and acted on only after it commits: the
	// QuickBooks void is an external call and must never see a local void that
	// could still roll back.
	const voidedInvoices: { id: string; qbInvoiceId: string | null }[] = [];

	const result = await sdb.$transaction(async (rawTx) => {
		const tx = rawTx as unknown as Prisma.TransactionClient;
		// Row lock before the load. Payments stay allowed mid-dispute (D7) and
		// insertInvoicePayment takes the same lock, so a Repeal and a payment on
		// one invoice serialize instead of both passing a money check made
		// against stale rows. organization_id is in the predicate because raw
		// SQL bypasses getScopedDb.
		if (kind === "invoice") {
			await tx.$queryRaw`SELECT id FROM invoice WHERE id = ${documentId} AND organization_id = ${organizationId} FOR UPDATE`;
		}
		const doc = await adapter.load(tx, documentId, organizationId);
		if (!doc) return { err: `${kind} not found` };

		const dispute = await tx.document_dispute.findFirst({
			where: {
				id: disputeId,
				[adapter.foreignKey]: documentId,
				status: "Open",
			},
		});
		if (!dispute)
			return { err: "No open dispute found for this document." };

		const outcome = input.resolution as Outcome;
		// Before the compare-and-swap, so any refusal leaves the dispute Open
		// for a retry, or for whoever is allowed to close it.
		const refused = outcomeRefusalFor(
			kind,
			doc,
			dispute.opened_by_dispatcher_id,
			outcome,
			authz,
			context.dispatcherId,
		);
		if (refused) return refused;

		// Compare-and-swap: two dispatchers must not both resolve the same dispute.
		const claimed = await tx.document_dispute.updateMany({
			where: { id: disputeId, status: "Open" },
			data: {
				status: "Resolved",
				resolution: outcome,
				resolution_note: input.note ?? null,
				resolved_by_dispatcher_id: context.dispatcherId ?? null,
				resolved_at: new Date(),
			},
		});
		if (claimed.count === 0) {
			return conflict(
				"This dispute was already resolved by someone else.",
			);
		}

		let replacementId: string | null = null;

		const writes = WRITES[kind];
		const recordInvoiceVoid = () => {
			if (writes.voidsOriginalInvoice) {
				voidedInvoices.push({
					id: doc.id,
					qbInvoiceId: doc.qb_invoice_id ?? null,
				});
			}
		};

		if (outcome === "Repeal") {
			await writes.repeal(tx, doc, input.note ?? "");
			recordInvoiceVoid();
		} else if (outcome === "ReviseAndResend") {
			replacementId = await writes.revise(
				tx,
				doc,
				organizationId,
				context,
			);
			recordInvoiceVoid();
			await tx.document_dispute.update({
				where: { id: disputeId },
				data: {
					[writes.replacementColumn]: replacementId,
				} as Prisma.document_disputeUpdateInput,
			});
		} else if (outcome === "IssueAdjustment") {
			const adjustmentId = await createAdjustmentInvoice(
				tx,
				doc,
				input.adjustment_lines ?? [],
				organizationId,
				context,
			);
			await tx.document_dispute.update({
				where: { id: disputeId },
				data: { adjustment_invoice_id: adjustmentId },
			});
			await restoreInvoiceStatus(
				tx,
				doc.id,
				doc.status,
				dispute.status_at_open,
			);
		} else {
			// The compare-and-swap above has already marked the dispute
			// Resolved. A new dispute_resolution value added to the enum and
			// the Zod schema but not to this chain would leave the document
			// stuck at Disputed with a row claiming it was resolved — so fail
			// the transaction rather than silently doing nothing.
			const unhandled: never = outcome;
			throw new Error(
				`Unhandled dispute resolution: ${String(unhandled)}`,
			);
		}

		await logActivity({
			event_type: `${kind}.dispute_resolved`,
			action: "updated",
			entity_type: kind,
			entity_id: documentId,
			organization_id: organizationId,
			actor_type: context.dispatcherId ? "dispatcher" : "system",
			actor_id: context.dispatcherId,
			reason: input.note,
			changes: {
				dispute_resolution: { old: null, new: outcome },
				replacement: { old: null, new: replacementId },
				...documentNumberChange(kind, doc),
			},
			ip_address: context.ipAddress,
			user_agent: context.userAgent,
		});

		return await tx.document_dispute.findFirst({
			where: { id: disputeId },
		});
	});

	// The kebab's Void behaviour, whichever door the void came through (D3).
	for (const voided of voidedInvoices) {
		mirrorInvoiceVoidToQuickBooks(organizationId, voided.id, voided.qbInvoiceId);
	}
	return result;
}

async function repealQuote(
	tx: Prisma.TransactionClient,
	doc: DocumentShape,
	note: string,
) {
	assertValidQuoteTransition(doc.status, "Cancelled");
	await tx.quote.update({
		where: { id: doc.id },
		data: { status: "Cancelled", rejection_reason: note },
	});
}

async function voidInvoice(
	tx: Prisma.TransactionClient,
	doc: DocumentShape,
	note: string,
) {
	// The adapter's unavailableReason judged eligibility from data loaded once,
	// up front. voidInvoice and reviseInvoice are the functions that actually
	// perform the write, so both restate this check against the live rows —
	// otherwise a race between that load and this line could strand a payment
	// or a credit on a dead record. Read from the payment rows, not the cached
	// amount_paid: under resolveDispute's row lock the aggregate is
	// authoritative and the denormalised column can be stale (DW-53).
	const paymentBlock = voidBlockedByPaymentReason(
		await invoicePaidTotal(doc.id, tx),
	);
	if (paymentBlock) throw new DocumentRuleError(paymentBlock);
	const liveAdjustments = await tx.invoice.findMany({
		where: { adjusts_invoice_id: doc.id, status: { not: "Void" } },
		select: { invoice_number: true },
	});
	const adjustmentBlock = voidBlockedByAdjustmentReason(liveAdjustments);
	if (adjustmentBlock) throw new DocumentRuleError(adjustmentBlock);

	assertValidInvoiceTransition(doc.status, "Void");
	await tx.invoice.update({
		where: { id: doc.id },
		data: {
			status: "Void",
			void_reason: note,
			voided_at: new Date(),
			// The same write the kebab's Void makes: not_synced until
			// mirrorInvoiceVoidToQuickBooks, after commit, voids it there too.
			qb_sync_status: "not_synced",
		},
	});
	// Repealing an adjustment must stop its credit counting against the job.
	await syncBilledAmounts(doc.id, tx);
}

async function reviseInvoice(
	tx: Prisma.TransactionClient,
	doc: DocumentShape,
	organizationId: string,
	context: UserContext,
): Promise<string> {
	const original = await tx.invoice.findFirst({ where: { id: doc.id } });
	if (!original) throw new Error("invoice not found");

	// Same restatement as voidInvoice, and the same reason it reads the
	// payment rows rather than the cached column (DW-53).
	if ((await invoicePaidTotal(doc.id, tx)) > 0) {
		throw new DocumentRuleError(
			"Cannot replace an invoice that holds a payment",
		);
	}

	// Same restatement, for the adjustment chain. A voided adjustment credits
	// nothing and does not block.
	const adjustmentCount = await tx.invoice.count({
		where: { adjusts_invoice_id: doc.id, status: { not: "Void" } },
	});
	if (adjustmentCount > 0) {
		throw new DocumentRuleError(
			"Cannot replace an invoice that has already been adjusted",
		);
	}

	const lines = await tx.invoice_line_item.findMany({
		where: { invoice_id: doc.id },
		orderBy: { sort_order: "asc" },
	});

	const invoiceNumber = await generateInvoiceNumber(tx, organizationId);
	const now = new Date();

	// D5: the replacement's due date is the LATER of the original's and
	// (reissue date + the original's terms). issue_date is now, so copying
	// due_date verbatim could re-issue a document already past due and age it
	// in AR from day one; recomputing from terms alone could instead shorten a
	// window the client still had. Past-due history stays on the voided
	// original through lineage. Null terms → keep the original date; null
	// original date → the terms date.
	let termsDue: Date | null = null;
	if (original.payment_terms_days != null) {
		termsDue = new Date(now);
		termsDue.setDate(termsDue.getDate() + original.payment_terms_days);
	}
	const replacementDueDate =
		original.due_date && termsDue
			? original.due_date.getTime() >= termsDue.getTime()
				? original.due_date
				: termsDue
			: (original.due_date ?? termsDue);

	const replacement = await tx.invoice.create({
		data: {
			organization_id: organizationId,
			invoice_number: invoiceNumber,
			client_id: original.client_id,
			status: "Issued",
			recurring_plan_id: original.recurring_plan_id,
			issue_date: now,
			due_date: replacementDueDate,
			payment_terms_days: original.payment_terms_days,
			issued_at: now,
			subtotal: original.subtotal,
			tax_rate: original.tax_rate,
			tax_amount: original.tax_amount,
			discount_type: original.discount_type,
			discount_value: original.discount_value,
			discount_amount: original.discount_amount,
			total: original.total,
			amount_paid: 0,
			balance_due: original.total,
			memo: original.memo,
			internal_notes: original.internal_notes,
			// Carrying the original snapshot keeps service-date tax rather than
			// re-taxing at today's rates.
			tax_snapshot: original.tax_snapshot ?? undefined,
			version: original.version + 1,
			previous_invoice_id: original.id,
			created_by_dispatcher_id: context.dispatcherId ?? null,
		},
	});

	if (lines.length > 0) {
		await tx.invoice_line_item.createMany({
			data: lines.map((li) => ({
				invoice_id: replacement.id,
				source_job_id: li.source_job_id,
				source_visit_id: li.source_visit_id,
				...pick(li, REVISION_LINE_FIELDS),
			})),
		});
	}

	await copyDocumentNotes(tx, "invoice", doc.id, replacement.id, context);

	// Job and visit attribution moves wholesale. Leaving it on the voided
	// original makes every affected job read as billed zero.
	await tx.invoice_job.updateMany({
		where: { invoice_id: doc.id },
		data: { invoice_id: replacement.id },
	});
	await tx.invoice_visit.updateMany({
		where: { invoice_id: doc.id },
		data: { invoice_id: replacement.id },
	});

	assertValidInvoiceTransition(doc.status, "Void");
	await tx.invoice.update({
		where: { id: doc.id },
		data: {
			status: "Void",
			void_reason: `Replaced by ${invoiceNumber} — dispute resolution`,
			voided_at: now,
			// See voidInvoice: not_synced until the post-commit QuickBooks void.
			qb_sync_status: "not_synced",
		},
	});

	await syncBilledAmounts(replacement.id, tx);

	return replacement.id;
}

/**
 * After an adjustment the original returns to status_at_open. Sent, Viewed and
 * Issued all restore directly — nothing re-locks, because finalization is keyed
 * on leaving Draft (isInvoiceFinalizingTransition) and issued_at is write-once,
 * so neither an email date nor a hand-delivery date gets overwritten.
 * PartiallyPaid and Paid restore through Sent and are then recomputed from the
 * payment rows by syncInvoicePaymentTotals.
 */
async function restoreInvoiceStatus(
	tx: Prisma.TransactionClient,
	invoiceId: string,
	fromStatus: string,
	statusAtOpen: string,
) {
	const target =
		statusAtOpen === "PartiallyPaid" || statusAtOpen === "Paid"
			? "Sent"
			: statusAtOpen;
	// Guarded against the document's real status, never the literal
	// "Disputed" — asserting against a status the row may no longer hold would
	// happily write Sent over a Void invoice and un-void it.
	assertValidInvoiceTransition(fromStatus, target);
	await tx.invoice.update({
		where: { id: invoiceId },
		// statusAtOpen is a plain string on the dispute row; the transition
		// guard above is what proves it is a real invoice_status.
		data: { status: target as invoice_status },
	});
	await syncInvoicePaymentTotals(invoiceId, tx);
}
