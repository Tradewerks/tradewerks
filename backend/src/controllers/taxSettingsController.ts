import type { Prisma } from "../../generated/prisma/client.js";
import { getScopedDb } from "../lib/context.js";
import { OPEN } from "../lib/statusTransitions.js";
import { recomputeDocumentTotals, type DocumentModel } from "../lib/recomputeDocumentTotals.js";
import { updateTaxSettingsSchema } from "../lib/validate/tax.js";
import { log } from "../services/appLogger.js";
import { logActivity } from "../services/logger.js";
import { getQBTaxPrefs } from "../services/qb/qbTax.js";
import { addressState } from "../services/tax/address.js";
import { getOrgTaxContext, type TaxMode } from "../services/tax/taxMode.js";
import type { TaxErrResult, TaxResult } from "./taxController.js";

export interface TaxSettings {
	tax_mode: TaxMode;
	effective_tax_mode: TaxMode;
	auto_entitled: boolean;
	tax_registered_states: string[];
	org_state: string | null;
	/** QuickBooks is connected but no pass-through tax code is set; auto may be refused (non-AST). */
	qb_passthrough_required: boolean;
	/** Org flat rate (0-1): auto mode's last fallback when the lookup fails and no fallback group is set. */
	legacy_rate: number;
}

async function qbTaxState(orgId: string) {
	const org = await getScopedDb(orgId).organization.findUnique({
		where: { id: orgId },
		select: { tax_mode: true, qb_realm_id: true, qb_passthrough_tax_code_id: true },
	});
	return {
		storedAuto: org?.tax_mode === "auto",
		connected: !!org?.qb_realm_id,
		passthrough: org?.qb_passthrough_tax_code_id ?? null,
	};
}

/**
 * A non-AST QuickBooks company needs the pass-through code to carry an auto
 * invoice's resolved tax; without it QuickBooks computes its own and every push mismatches.
 * An unreadable preference counts as non-AST — guessing AST would let that happen silently.
 */
async function refuseUnlessAst(orgId: string, message: string): Promise<TaxErrResult | null> {
	try {
		if ((await getQBTaxPrefs(orgId)).automatedSalesTax) return null;
	} catch (err) {
		log.warn({ err, orgId }, "Could not read QuickBooks tax preferences");
	}
	return { ok: false, code: "CONFLICT", message };
}

type ScopedDb = ReturnType<typeof getScopedDb>;

interface ClearTargets {
	orgDefaultIds: string[];
	clientGroups: { groupId: string; clientIds: string[] }[];
}

/** Same org-default rule as the recompute: active default groups only. */
async function clearTargets(sdb: Pick<ScopedDb, "tax_group" | "client">): Promise<ClearTargets> {
	const [defaults, clients] = await Promise.all([
		sdb.tax_group.findMany({ where: { is_default: true, is_active: true }, select: { id: true } }),
		sdb.client.findMany({
			where: { tax_group_id: { not: null } },
			select: { id: true, tax_group_id: true },
		}),
	]);
	const byGroup = new Map<string, string[]>();
	for (const c of clients) {
		if (!c.tax_group_id) continue;
		byGroup.set(c.tax_group_id, [...(byGroup.get(c.tax_group_id) ?? []), c.id]);
	}
	return {
		orgDefaultIds: defaults.map((d) => d.id),
		clientGroups: [...byGroup].map(([groupId, clientIds]) => ({ groupId, clientIds })),
	};
}

const hasTargets = (t: ClearTargets) => t.orgDefaultIds.length > 0 || t.clientGroups.length > 0;

/**
 * On drafts, a line whose group equals the org default, or the default group of that
 * document's own client, was a default the old manual recompute wrote back onto the line,
 * not a choice. A client group only counts on that client's documents.
 */
function defaultGroupLineFilters(orgId: string, t: ClearTargets) {
	const orgDefault = t.orgDefaultIds.length > 0 ? [{ tax_group_id: { in: t.orgDefaultIds } }] : [];
	const byClient = <W extends object>(parent: (clientIds: string[]) => W) =>
		t.clientGroups.map((c) => ({ tax_group_id: c.groupId, ...parent(c.clientIds) }));
	const or = <W extends object>(parent: (clientIds: string[]) => W) => [
		...orgDefault,
		...byClient(parent),
	];
	// Each entry is the parent document's own filter plus the line OR; the line `where` and the
	// document-count `where` are both derived from it so the two previews cannot drift apart.
	const quoteOr = or((ids) => ({ quote: { client_id: { in: ids } } }));
	const jobOr = or((ids) => ({ job: { client_id: { in: ids } } }));
	const visitOr = or((ids) => ({ visit: { job: { client_id: { in: ids } } } }));
	const invoiceOr = or((ids) => ({ invoice: { client_id: { in: ids } } }));
	const quoteDoc = { organization_id: orgId, status: "Draft" as const };
	const jobDoc = { organization_id: orgId, status: OPEN };
	const visitDoc = { status: OPEN, job: { organization_id: orgId } };
	const invoiceDoc = { organization_id: orgId, status: "Draft" as const };
	return {
		quote: { quote: quoteDoc, OR: quoteOr },
		job: { job: jobDoc, OR: jobOr },
		visit: { visit: visitDoc, OR: visitOr },
		invoice: { invoice: invoiceDoc, OR: invoiceOr },
		quoteDocs: { ...quoteDoc, line_items: { some: { OR: quoteOr } } },
		jobDocs: { ...jobDoc, line_items: { some: { OR: jobOr } } },
		visitDocs: { ...visitDoc, line_items: { some: { OR: visitOr } } },
		invoiceDocs: { ...invoiceDoc, line_items: { some: { OR: invoiceOr } } },
	};
}

export async function getTaxSettings(orgId: string): Promise<TaxSettings> {
	const [ctx, qb] = await Promise.all([getOrgTaxContext(orgId), qbTaxState(orgId)]);
	return {
		tax_mode: ctx.stored_mode,
		effective_tax_mode: ctx.mode,
		auto_entitled: ctx.auto_entitled,
		tax_registered_states: ctx.registered_states,
		org_state: addressState(ctx.address),
		qb_passthrough_required: qb.connected && !qb.passthrough,
		legacy_rate: ctx.legacy_rate,
	};
}

export async function setQBPassthroughTaxCode(
	orgId: string,
	code: string | null,
): Promise<TaxResult<{ passthroughTaxCodeId: string | null }>> {
	if (code === null) {
		const qb = await qbTaxState(orgId);
		// No connection means nothing is pushed, so there is nothing to protect.
		if (qb.storedAuto && qb.connected) {
			const refused = await refuseUnlessAst(
				orgId,
				"Turn off automated tax before removing the pass-through tax code.",
			);
			if (refused) return refused;
		}
	}
	const org = await getScopedDb(orgId).organization.update({
		where: { id: orgId },
		data: { qb_passthrough_tax_code_id: code },
		select: { qb_passthrough_tax_code_id: true },
	});
	return { ok: true, item: { passthroughTaxCodeId: org.qb_passthrough_tax_code_id } };
}

export interface AutoSwitchPreview {
	default_group_lines: number;
	quote_lines: number;
	job_lines: number;
	visit_lines: number;
	invoice_lines: number;
	default_group_drafts: number;
	quote_drafts: number;
	job_drafts: number;
	visit_drafts: number;
	invoice_drafts: number;
}

export async function previewAutoSwitch(orgId: string): Promise<AutoSwitchPreview> {
	const sdb = getScopedDb(orgId);
	const targets = await clearTargets(sdb);
	if (!hasTargets(targets)) {
		return {
			default_group_lines: 0,
			quote_lines: 0,
			job_lines: 0,
			visit_lines: 0,
			invoice_lines: 0,
			default_group_drafts: 0,
			quote_drafts: 0,
			job_drafts: 0,
			visit_drafts: 0,
			invoice_drafts: 0,
		};
	}
	const f = defaultGroupLineFilters(orgId, targets);
	const [quote_lines, job_lines, visit_lines, invoice_lines] = await Promise.all([
		sdb.quote_line_item.count({ where: f.quote }),
		sdb.job_line_item.count({ where: f.job }),
		sdb.job_visit_line_item.count({ where: f.visit }),
		sdb.invoice_line_item.count({ where: f.invoice }),
	]);
	const [quote_drafts, job_drafts, visit_drafts, invoice_drafts] = await Promise.all([
		sdb.quote.count({ where: f.quoteDocs }),
		sdb.job.count({ where: f.jobDocs }),
		sdb.job_visit.count({ where: f.visitDocs }),
		sdb.invoice.count({ where: f.invoiceDocs }),
	]);
	return {
		default_group_lines: quote_lines + job_lines + visit_lines + invoice_lines,
		quote_lines,
		job_lines,
		visit_lines,
		invoice_lines,
		default_group_drafts: quote_drafts + job_drafts + visit_drafts + invoice_drafts,
		quote_drafts,
		job_drafts,
		visit_drafts,
		invoice_drafts,
	};
}

export async function updateTaxSettings(
	orgId: string,
	body: unknown,
	actorId: string | null,
): Promise<
	TaxResult<TaxSettings & { cleared_default_lines: number; recompute_queued: number }>
> {
	const result = updateTaxSettingsSchema.safeParse(body);
	if (!result.success) {
		return {
			ok: false,
			code: "VALIDATION",
			message: result.error.issues.map((i) => i.message).join(", "),
		};
	}
	const parsed = result.data;

	const before = await getOrgTaxContext(orgId);
	if (parsed.tax_mode === "auto" && !before.auto_entitled) {
		return {
			ok: false,
			code: "NOT_IN_PLAN",
			message: "Automated Tax is not included in your plan.",
		};
	}

	const switchingToAuto = parsed.tax_mode === "auto" && before.stored_mode !== "auto";
	if (switchingToAuto) {
		const qb = await qbTaxState(orgId);
		if (qb.connected && !qb.passthrough) {
			const refused = await refuseUnlessAst(
				orgId,
				"Choose a QuickBooks pass-through tax code before turning on automated tax.",
			);
			if (refused) return refused;
		}
	}

	let states = parsed.tax_registered_states;
	// Registered states default to the org's own state, or every auto-mode
	// document would be flagged "Not registered" on day one.
	if (switchingToAuto && states === undefined && before.registered_states.length === 0) {
		const own = addressState(before.address);
		if (own) states = [own];
	}

	// An empty list under auto would flag every document "Not registered".
	const nextMode = parsed.tax_mode ?? before.stored_mode;
	if (nextMode === "auto" && states !== undefined && states.length === 0) {
		return {
			ok: false,
			code: "VALIDATION",
			message:
				"Automatic tax needs at least one state where you collect sales tax.",
		};
	}

	const { cleared, drafts } = await getScopedDb(orgId).$transaction(async (tx) => {
		await tx.organization.update({
			where: { id: orgId },
			data: {
				...(parsed.tax_mode !== undefined && { tax_mode: parsed.tax_mode }),
				...(states !== undefined && { tax_registered_states: states }),
			},
		});
		const none = { cleared: 0, drafts: null };
		if (!switchingToAuto) return none;
		const targets = await clearTargets(tx);
		if (!hasTargets(targets)) return none;
		const f = defaultGroupLineFilters(orgId, targets);
		// Collected before the clear: afterwards the documents no longer match the line filter.
		const select = { id: true } as const;
		const [quotes, jobs, visits, invoices] = await Promise.all([
			tx.quote.findMany({ where: f.quoteDocs, select }),
			tx.job.findMany({ where: f.jobDocs, select }),
			tx.job_visit.findMany({ where: f.visitDocs, select }),
			tx.invoice.findMany({ where: f.invoiceDocs, select }),
		]);
		const results = await Promise.all([
			tx.quote_line_item.updateMany({ where: f.quote, data: { tax_group_id: null } }),
			tx.job_line_item.updateMany({ where: f.job, data: { tax_group_id: null } }),
			tx.job_visit_line_item.updateMany({ where: f.visit, data: { tax_group_id: null } }),
			tx.invoice_line_item.updateMany({ where: f.invoice, data: { tax_group_id: null } }),
		]);
		const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
		return {
			cleared: results.reduce((n, r) => n + r.count, 0),
			drafts: {
				quote: ids(quotes),
				job: ids(jobs),
				job_visit: ids(visits),
				invoice: ids(invoices),
			} satisfies DraftTargets,
		};
	});

	await logActivity({
		event_type: "organization.tax_settings_updated",
		action: "updated",
		entity_type: "organization",
		entity_id: orgId,
		organization_id: orgId,
		actor_type: "dispatcher",
		actor_id: actorId,
		changes: {
			...(parsed.tax_mode !== undefined && {
				tax_mode: { old: before.stored_mode, new: parsed.tax_mode },
			}),
			...(states !== undefined && {
				tax_registered_states: { old: before.registered_states, new: states },
			}),
		},
	});

	// Not awaited: the switch is committed; the drafts' stored totals catch up in the background.
	if (drafts) {
		refreshDraftsAfterAutoSwitch(orgId, drafts).catch((err) =>
			log.error({ err, orgId }, "Draft recompute after auto-tax switch failed"),
		);
	}
	const recompute_queued = drafts
		? REFRESH_ORDER.reduce((n, model) => n + drafts[model].length, 0)
		: 0;

	return {
		ok: true,
		item: { ...(await getTaxSettings(orgId)), cleared_default_lines: cleared, recompute_queued },
	};
}

export type DraftTargets = Record<DocumentModel, string[]>;

// Jobs before visits: a visit resolves cache-only and inherits its job's freshly cached address.
const REFRESH_ORDER: DocumentModel[] = ["job", "job_visit", "quote", "invoice"];

/** One document per transaction, sequentially, so one failure cannot roll back or stall the rest. */
export async function refreshDraftsAfterAutoSwitch(
	orgId: string,
	targets: DraftTargets,
): Promise<void> {
	const sdb = getScopedDb(orgId);
	for (const model of REFRESH_ORDER) {
		for (const id of targets[model]) {
			try {
				// A { ok: false } result (locked since collection, or deleted) needs nothing more.
				await sdb.$transaction((tx) =>
					recomputeDocumentTotals(model, id, orgId, tx as unknown as Prisma.TransactionClient),
				);
			} catch (err) {
				log.error({ err, orgId, model, id }, "Draft recompute after auto-tax switch failed");
			}
		}
	}
}
