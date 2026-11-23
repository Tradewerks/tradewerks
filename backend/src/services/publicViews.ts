import { db } from "../db.js";
import { getScopedDb } from "../lib/context.js";
import type { ResolvedLink } from "../lib/publicLink.js";
import { generateInvoicePdf, generateQuotePdf } from "../lib/pdf/pdfService.js";
import { quoteCanRespond } from "../controllers/quotesController.js";
import { logActivity } from "./logger.js";
import { buildVisitModel } from "./visitMessageModel.js";
import { signImageUrl } from "./wasabiService.js";
import { log } from "./appLogger.js";

// Every payload here is built field by field from an explicit select: a customer
// must never see ids, costs, internal notes, tax resolution data or anything
// another client owns, and a spread would leak whatever a later column adds.

type ScopedDb = ReturnType<typeof getScopedDb>;

export interface Requester {
	ip?: string;
	userAgent?: string;
}

interface PublicLineItem {
	name: string;
	description: string | null;
	quantity: number;
	unit_price: number;
	total: number;
}

export interface QuoteView {
	number: string;
	title: string;
	status: string;
	line_items: PublicLineItem[];
	subtotal: number;
	discount_amount: number;
	tax_amount: number;
	total: number;
	valid_until: string | null;
	can_respond: boolean;
	superseded: boolean;
	approved_at: string | null;
	approved_by_name: string | null;
}

export interface InvoiceView {
	number: string;
	status_label: string;
	issue_date: string | null;
	due_date: string | null;
	line_items: PublicLineItem[];
	total: number;
	amount_paid: number;
	balance_due: number;
}

export interface VisitView {
	date: string;
	window: string;
	address: string;
	status_label: string;
	// Stable coarse state for client behaviour; status_label is editable copy.
	phase: VisitPhase;
	tech_first_names: string[];
	eta: string | null;
	tech_photo_url: string | null;
	/** What was done; only once the visit is Completed. */
	summary: { name: string | null; description: string | null } | null;
	photos: VisitPhoto[];
}

interface VisitPhoto {
	url: string;
	label: string;
	name: string | null;
}

// Signed per request, so a link that outlives the signature still shows them.
const PHOTO_TTL_SECONDS = 3600;

/** Null, with a log line, when signing fails: one bad photo must not take the page down. */
async function signOrNull(
	url: string | null,
	visitId: string,
	what: string,
): Promise<string | null> {
	try {
		return await signImageUrl(url, PHOTO_TTL_SECONDS);
	} catch (err) {
		// SDK errors carry the bucket URL, request metadata and sometimes key
		// ids; only the name and a scrubbed message are logged.
		const e = err instanceof Error ? err : new Error(String(err));
		log.warn(
			{ errName: e.name, errMessage: scrubSecrets(e.message), visitId },
			`visit page ${what} could not be signed`,
		);
		return null;
	}
}

function scrubSecrets(message: string): string {
	return message
		.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, "[url]")
		.replace(
			/\b[\w-]*(?:key|secret|token|signature|credential)[\w-]*=\S+/gi,
			"[redacted]",
		)
		.replace(/\b[A-Za-z0-9+/_-]{16,}\b/g, "[redacted]");
}

export type VisitPhase = "scheduled" | "driving" | "arrived" | "done" | "other";

const VISIT_PHASES: Record<string, VisitPhase> = {
	Scheduled: "scheduled",
	Driving: "driving",
	OnSite: "arrived",
	Completed: "done",
	Cancelled: "done",
};

export type PublicView = QuoteView | InvoiceView | VisitView;

// Customer wording: Sent/Viewed are the office's tracking states, not the
// customer's, and a paused visit is still in progress to them.
const INVOICE_LABELS: Record<string, string> = {
	Draft: "Draft",
	Issued: "Due",
	Sent: "Due",
	Viewed: "Due",
	PartiallyPaid: "Partially paid",
	Paid: "Paid",
	Disputed: "Under review",
	Void: "Void",
};

const VISIT_LABELS: Record<string, string> = {
	Scheduled: "Scheduled",
	Driving: "On the way",
	OnSite: "Arrived",
	InProgress: "In progress",
	Paused: "In progress",
	Delayed: "Delayed",
	Completed: "Completed",
	Cancelled: "Cancelled",
};

const lineItemSelect = {
	select: {
		name: true,
		description: true,
		quantity: true,
		unit_price: true,
		total: true,
	},
	orderBy: { sort_order: "asc" },
} as const;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function publicLines(
	rows: {
		name: string;
		description: string | null;
		quantity: unknown;
		unit_price: unknown;
		total: unknown;
	}[],
): PublicLineItem[] {
	return rows.map((r) => ({
		name: r.name,
		description: r.description ?? null,
		quantity: Number(r.quantity),
		unit_price: Number(r.unit_price),
		total: Number(r.total),
	}));
}

export async function buildQuoteView(
	sdb: ScopedDb,
	quoteId: string,
): Promise<QuoteView | null> {
	const q = await sdb.quote.findFirst({
		where: { id: quoteId },
		select: {
			quote_number: true,
			title: true,
			status: true,
			subtotal: true,
			discount_amount: true,
			tax_amount: true,
			total: true,
			valid_until: true,
			expires_at: true,
			approved_at: true,
			approved_by_name: true,
			approved_via: true,
			request: { select: { status: true } },
			line_items: lineItemSelect,
		},
	});
	// A draft was never sent, whatever link exists for it.
	if (!q || q.status === "Draft") return null;
	return {
		number: q.quote_number,
		title: q.title,
		status: q.status,
		line_items: publicLines(q.line_items),
		subtotal: Number(q.subtotal),
		discount_amount: Number(q.discount_amount ?? 0),
		tax_amount: Number(q.tax_amount),
		total: Number(q.total),
		valid_until: iso(q.valid_until),
		can_respond: quoteCanRespond(q),
		superseded: q.status === "Revised",
		approved_at: iso(q.approved_at),
		// A staff approval records the dispatcher's name, which is not the
		// customer's to see.
		approved_by_name:
			q.approved_via === "customer_link" ? q.approved_by_name : null,
	};
}

async function buildInvoiceView(
	sdb: ScopedDb,
	invoiceId: string,
): Promise<InvoiceView | null> {
	const inv = await sdb.invoice.findFirst({
		where: { id: invoiceId },
		select: {
			invoice_number: true,
			status: true,
			issue_date: true,
			due_date: true,
			total: true,
			amount_paid: true,
			balance_due: true,
			line_items: lineItemSelect,
		},
	});
	if (!inv || inv.status === "Draft") return null;
	return {
		number: inv.invoice_number,
		status_label: INVOICE_LABELS[inv.status] ?? inv.status,
		issue_date: iso(inv.issue_date),
		due_date: iso(inv.due_date),
		line_items: publicLines(inv.line_items),
		total: Number(inv.total),
		amount_paid: Number(inv.amount_paid),
		balance_due: Number(inv.balance_due),
	};
}

async function buildVisitView(
	sdb: ScopedDb,
	orgId: string,
	visitId: string,
): Promise<VisitView | null> {
	const org = await db.organization.findUnique({
		where: { id: orgId },
		select: { timezone: true },
	});
	const model = await buildVisitModel(
		sdb,
		visitId,
		org?.timezone ?? "America/Chicago",
	);
	if (!model) return null;
	const shared = await sdb.job_note_photo.findMany({
		where: { share_with_customer: true, note: { visit_id: visitId } },
		orderBy: { created_at: "asc" },
		select: { photo_url: true, photo_label: true, photo_name: true },
	});
	const photos: VisitPhoto[] = [];
	for (const p of shared) {
		const url = await signOrNull(p.photo_url, visitId, "photo");
		if (url) photos.push({ url, label: p.photo_label, name: p.photo_name });
	}
	return {
		date: model.visit.date,
		window: model.visit.window,
		address: model.visit.address,
		status_label: VISIT_LABELS[model.status] ?? model.status,
		phase: VISIT_PHASES[model.status] ?? "other",
		tech_first_names: model.tech_first_names,
		// Once the tech is on site a countdown is wrong, and before they leave
		// there is no drive to estimate.
		eta:
			model.status === "Driving" && model.visit.eta
				? model.visit.eta
				: null,
		tech_photo_url: await signOrNull(
			model.tech_photo_raw_url,
			visitId,
			"tech photo",
		),
		summary:
			model.status === "Completed"
				? {
						name: model.visit.name || null,
						description: model.visit.description || null,
					}
				: null,
		photos,
	};
}

/** Moves a Sent document to Viewed once; the status guard makes repeats no-ops. */
async function markViewed(
	orgId: string,
	kind: "quote" | "invoice",
	id: string,
	who: Requester,
): Promise<void> {
	const sdb = getScopedDb(orgId);
	const where = { id, status: "Sent" as const };
	const data = { status: "Viewed" as const, viewed_at: new Date() };
	const { count } =
		kind === "quote"
			? await sdb.quote.updateMany({ where, data })
			: await sdb.invoice.updateMany({ where, data });
	if (!count) return;
	await logActivity({
		event_type: `${kind}.updated`,
		action: "updated",
		entity_type: kind,
		entity_id: id,
		organization_id: orgId,
		actor_type: "customer",
		actor_name: "Customer (online link)",
		changes: { status: { old: "Sent", new: "Viewed" } },
		ip_address: who.ip,
		user_agent: who.userAgent,
	});
}

/**
 * The page payload for a link; null when its entity is not in the link's org or
 * is a draft. `markViewed` is opt-in: the page asks for it once the document
 * has actually been on screen, so link scanners and prefetchers don't count.
 */
export async function buildPublicView(
	link: ResolvedLink,
	opts: Requester & { markViewed?: boolean } = {},
): Promise<PublicView | null> {
	const orgId = link.organization_id;
	const sdb = getScopedDb(orgId);
	switch (link.purpose) {
		case "quote":
			if (opts.markViewed)
				await markViewed(orgId, "quote", link.entity_id, opts);
			return buildQuoteView(sdb, link.entity_id);
		case "invoice":
			if (opts.markViewed)
				await markViewed(orgId, "invoice", link.entity_id, opts);
			return buildInvoiceView(sdb, link.entity_id);
		case "visit":
			return buildVisitView(sdb, orgId, link.entity_id);
		default:
			return null;
	}
}

const safeName = (s: string) => s.replace(/[^\w.-]+/g, "_");

/** Quote and invoice links only; the document is always the link's own entity. */
export async function documentPdf(
	link: ResolvedLink,
): Promise<{ buffer: Buffer; filename: string } | null> {
	const orgId = link.organization_id;
	const sdb = getScopedDb(orgId);
	if (link.purpose === "quote") {
		const q = await sdb.quote.findFirst({
			where: { id: link.entity_id },
			select: { quote_number: true, status: true },
		});
		if (!q || q.status === "Draft" || q.status === "Cancelled") return null;
		return {
			buffer: await generateQuotePdf(link.entity_id, orgId),
			filename: `quote-${safeName(q.quote_number)}.pdf`,
		};
	}
	if (link.purpose === "invoice") {
		const inv = await sdb.invoice.findFirst({
			where: { id: link.entity_id },
			select: { invoice_number: true, status: true },
		});
		if (!inv || inv.status === "Draft" || inv.status === "Void")
			return null;
		return {
			buffer: await generateInvoicePdf(link.entity_id, orgId),
			filename: `invoice-${safeName(inv.invoice_number)}.pdf`,
		};
	}
	return null;
}
