import type { Prisma } from "../../generated/prisma/client.js";
import { generateInvoiceNumber } from "../db.js";
import { logActivity } from "./logger.js";
import {
	lockInvoiceTaxSnapshot,
	syncBilledAmounts,
} from "./invoiceService.js";
import type { UserContext } from "../lib/context.js";
import { assertLineRefsInOrg } from "../lib/lineRefs.js";
import { DocumentRuleError } from "../lib/statusTransitions.js";
import type { AdjustmentLineInput } from "../lib/validate/invoices.js";
import type { DocumentShape } from "./disputeAdapters.js";

/**
 * An issued invoice is immutable — the tax snapshot lock in invoicesController
 * enforces it and accounting practice agrees. Corrections therefore arrive as a
 * separate linked document carrying only the delta, exactly as ServiceTitan's
 * adjustment invoice works. Net negative is a credit.
 *
 * This deliberately does NOT go through createInvoiceRecord: that path
 * auto-pushes to QuickBooks when connected, and exporting a net-negative
 * document as a credit memo is out of scope.
 */
/** The root invoice's billed jobs and visits: where a credit can land. */
export interface BilledTargets {
	jobIds: readonly string[];
	visits: readonly { visit_id: string; job_id: string }[];
}

/**
 * Every credit lands on a job, or job profitability keeps the pre-credit
 * revenue: syncBilledAmounts only sums lines whose source matches one of the
 * root's invoice_job / invoice_visit rows (D4). A root billing exactly one job
 * or visit takes unattributed lines by default. A root billing several needs
 * each line to name one, because spreading a credit pro-rata is a guess no
 * surveyed product makes. A root billing none has nowhere to attribute to.
 *
 * A named job or visit the root does not bill is refused rather than stored,
 * since its credit could never reach any billed amount.
 */
export function attributeAdjustmentLines<L extends AdjustmentLineInput>(
	lines: readonly L[],
	targets: BilledTargets,
): L[] {
	const visitJob = new Map(targets.visits.map((v) => [v.visit_id, v.job_id]));
	const jobIds = new Set(targets.jobIds);
	const targetCount = jobIds.size + visitJob.size;

	return lines.map((line) => {
		if (line.source_visit_id) {
			if (!visitJob.has(line.source_visit_id)) {
				throw new DocumentRuleError(
					"An adjustment line credits a visit this invoice doesn't bill. Choose one of the visits on the invoice.",
				);
			}
			return line;
		}
		if (line.source_job_id) {
			if (!jobIds.has(line.source_job_id)) {
				throw new DocumentRuleError(
					"An adjustment line credits a job this invoice doesn't bill. Choose one of the jobs on the invoice.",
				);
			}
			return line;
		}
		if (targetCount === 0) return line;
		if (targetCount > 1) {
			throw new DocumentRuleError(
				"This invoice bills more than one job or visit, so each adjustment line has to name the one it credits.",
			);
		}
		const [onlyJob] = jobIds;
		if (onlyJob) return { ...line, source_job_id: onlyJob };
		const [[visitId, jobId]] = visitJob;
		return { ...line, source_visit_id: visitId, source_job_id: jobId };
	});
}

async function loadBilledTargets(
	tx: Prisma.TransactionClient,
	rootId: string,
): Promise<BilledTargets> {
	const [jobs, visits] = await Promise.all([
		tx.invoice_job.findMany({
			where: { invoice_id: rootId },
			select: { job_id: true },
		}),
		tx.invoice_visit.findMany({
			where: { invoice_id: rootId },
			select: { visit_id: true, visit: { select: { job_id: true } } },
		}),
	]);
	return {
		jobIds: jobs.map((j) => j.job_id),
		visits: visits.map((v) => ({ visit_id: v.visit_id, job_id: v.visit.job_id })),
	};
}

export async function createAdjustmentInvoice(
	tx: Prisma.TransactionClient,
	doc: DocumentShape,
	lines: AdjustmentLineInput[],
	organizationId: string,
	context: UserContext,
): Promise<string> {
	// Lock the original before reading its adjustment chain: the cumulative
	// credit ceiling below is only sound if two concurrent adjustments cannot
	// both read the same pre-credit total and both pass it.
	await tx.$queryRaw`SELECT id FROM invoice WHERE id = ${doc.id} AND organization_id = ${organizationId} FOR UPDATE`;

	const original = await tx.invoice.findFirst({ where: { id: doc.id } });
	if (!original) throw new Error("invoice not found");

	// Chaining adjustments would make "what is actually owed" a walk of an
	// arbitrarily long list; every correction hangs off the original instead.
	if (original.adjusts_invoice_id) {
		throw new DocumentRuleError(
			"An adjustment cannot itself be adjusted. Issue a further adjustment against the original invoice.",
		);
	}

	if (lines.length === 0)
		throw new DocumentRuleError("An adjustment needs at least one line");

	await assertLineRefsInOrg(tx, organizationId, lines);
	const attributed = attributeAdjustmentLines(
		lines,
		await loadBilledTargets(tx, original.id),
	);

	const subtotal = lines.reduce((sum, li) => sum + li.total, 0);
	const invoiceNumber = await generateInvoiceNumber(tx, organizationId);
	const now = new Date();

	// A net-positive adjustment is a bill, and without the original's terms it
	// would age in AR from the moment it was created rather than from its due
	// date (the AR report falls back to COALESCE(due_date, created_at)).
	let dueDate: Date | null = null;
	if (original.payment_terms_days) {
		dueDate = new Date(now);
		dueDate.setDate(dueDate.getDate() + original.payment_terms_days);
	}

	const adjustment = await tx.invoice.create({
		data: {
			organization_id: organizationId,
			invoice_number: invoiceNumber,
			client_id: original.client_id,
			status: "Issued",
			issue_date: now,
			issued_at: now,
			due_date: dueDate,
			payment_terms_days: original.payment_terms_days,
			subtotal,
			// Provisional: the real figures are written below by
			// lockInvoiceTaxSnapshot, which cannot run until the lines exist.
			tax_rate: 0,
			tax_amount: 0,
			total: subtotal,
			amount_paid: 0,
			balance_due: subtotal,
			memo: `Adjusts ${original.invoice_number}`,
			adjusts_invoice_id: original.id,
			qb_sync_status: "not_synced",
			created_by_dispatcher_id: context.dispatcherId ?? null,
		},
	});

	await tx.invoice_line_item.createMany({
		data: attributed.map((li, index) => ({
			invoice_id: adjustment.id,
			name: li.name,
			description: li.description ?? null,
			quantity: li.quantity,
			unit_price: li.unit_price,
			total: li.total,
			sort_order: index,
			source_job_id: li.source_job_id ?? null,
			source_visit_id: li.source_visit_id ?? null,
			tax_group_id: li.tax_group_id ?? null,
			taxable: li.taxable ?? true,
			inventory_item_id: li.inventory_item_id ?? null,
		})),
	});

	// A credit that omits tax makes the organisation over-remit, so the
	// adjustment is taxed from its own lines and locked at issue exactly as any
	// other Issued invoice is. The shared recompute is sign-agnostic: the
	// subtotal is a signed reduce, per-line tax keeps the line's sign, and the
	// discount block (which is not) is skipped because adjustments carry none.
	await lockInvoiceTaxSnapshot(adjustment.id, organizationId, tx, now);

	// Must follow the lock: it rewrites the line-level tax the join rows sum.
	// Kept here rather than in the caller so any future caller inherits it.
	// The attribution above is what lets the credit reach job profitability;
	// syncBilledAmounts resolves the chain root itself, so the adjustment's own
	// id is correct.
	await syncBilledAmounts(adjustment.id, tx);

	// The signed line sum above is pre-tax and provisional; the lock has since
	// written the real total, so read it back rather than logging the sum or
	// falling back to `subtotal` — either would put a plausible-but-wrong
	// figure in the one artifact spec §12 relies on for single-actor repeal.
	const written = await tx.invoice.findFirst({
		where: { id: adjustment.id },
		select: { total: true },
	});
	if (!written) {
		throw new Error("Adjustment invoice not readable after creation");
	}

	// Over-crediting ceiling, checked against the tax-locked total rather than
	// the provisional pre-tax sum, and cumulative across the whole chain — a
	// $500 invoice cannot accumulate $600 of credit through two adjustments
	// that each looked acceptable alone.
	//
	// This is the industry rule, not an invention: NetSuite refuses a credit
	// note larger than the invoice, QuickBooks caps a credit at the original,
	// Zuora ships it as the "Available to credit validation" setting evaluated
	// against the whole invoice, and Oracle Receivables allows the excess only
	// behind an explicit "Allow overapplication" flag. Positive adjustments are
	// uncapped in all of them: billing more is a new charge, not over-crediting.
	//
	// Throwing rolls back the whole transaction, including this row and its
	// lines, because everything here runs inside resolveDispute's $transaction.
	// A voided adjustment credits nothing, so it no longer uses up the ceiling;
	// otherwise "void the adjustment first" would strand the credit it replaces.
	const chain = await tx.invoice.aggregate({
		where: { adjusts_invoice_id: original.id, status: { not: "Void" } },
		_sum: { total: true },
	});
	const netAdjustments = Number(chain._sum.total ?? 0);
	const originalTotal = Number(original.total);
	if (netAdjustments < -originalTotal) {
		const priorNet = netAdjustments - Number(written.total);
		const remaining = originalTotal + priorNet;
		throw new DocumentRuleError(
			`This adjustment would credit more than ${original.invoice_number} is worth. ` +
				`It totals ${originalTotal.toFixed(2)}, ` +
				`${Math.abs(priorNet).toFixed(2)} has already been adjusted against it, ` +
				`so at most ${remaining.toFixed(2)} can still be credited.`,
		);
	}

	await logActivity({
		event_type: "invoice.adjustment_created",
		action: "created",
		entity_type: "invoice",
		entity_id: adjustment.id,
		organization_id: organizationId,
		actor_type: context.dispatcherId ? "dispatcher" : "system",
		actor_id: context.dispatcherId,
		changes: {
			adjusts: { old: null, new: original.invoice_number },
			total: { old: null, new: Number(written.total) },
		},
	});

	return adjustment.id;
}
