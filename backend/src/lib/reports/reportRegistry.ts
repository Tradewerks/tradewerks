import {
	getJobsReport,
	getJobsReportPage,
	getFirstTimeFixReport,
	getInvoicesReport,
	getInvoicesReportPage,
	getClientsReport,
	getInventoryReport,
	getInventoryReportPage,
	getInventoryReorderForecast,
	getPaymentsReport,
	getPaymentsReportPage,
	getQuoteFunnelReport,
	getQuoteRowsPage,
	getQuoteFunnelSummary,
	getTaxLiabilityReport,
	getAgedReceivablesByClient,
	getClientRetentionReport,
	getClientLifetimeValueReport,
	getClientDiscountsReport,
	getFieldAddedRevenueReport,
	getRecurringRevenueReport,
	getRevenueByLineItemType,
	getRevenueLineItemsReport,
	getRevenueLineItemsReportPage,
	reportInstant,
	getProjectsReport,
	getProjectsReportPage,
	getCogsByItemReport,
	getCogsByJobReport,
	getJobProfitabilityReport
} from "../../controllers/reportsController.js";
import type { PaginateParams, ReportRow } from "./filterEngine.js";
import { num, round2 } from "./numbers.js";
import { unitDisplay, unitWord } from "../units.js";

// Catalog of eery report and a key to each report
export interface ReportQuery {
	startDate?: string;
	endDate?: string;
	includeInactive?: boolean;
	lookbackDays?: number;
}

export interface ReportDefinition {
	load: (
		orgId: string,
		query: ReportQuery,
	) => Promise<{ rows: ReportRow[]; summary?: Record<string, unknown> }>;
	filteredSummary?: (rows: ReportRow[]) => Record<string, unknown>;
	/**
	 * Row keys free-text search may look at. Server-side only — it must never be
	 * client-supplied, so it is absent from paginateParamsSchema and
	 * exportServerSchema. Omitted means `filterRows` falls back to every key
	 * except "id", which makes UUIDs and currency figures searchable.
	 *
	 * ⚠️ Only valid on a definition with NO `loadPage`: a loadPage report pushes
	 * search into SQL, where searchability is already per-column, so setting both
	 * makes page-1 search diverge from export search. Enforced below.
	 */
	searchKeys?: string[];
	loadPage?: (
		orgId: string,
		query: ReportQuery,
		params: PaginateParams,
	) => Promise<{
		rows: ReportRow[];
		total: number;
		page: number;
		pageSize: number;
		summary?: Record<string, unknown>;
	} | null>;
}

const TZ = "America/Chicago";

const fmtDate = (value: Date | string | null | undefined): string =>
	value == null
		? "—"
		: new Date(value).toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				year: "numeric",
				timeZone: TZ,
			});

const fmtQty = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

// Quantities carry their unit — "6" and "6 ft" are different facts, and the
// column header can't say which because the unit is per item, not per column.
const withUnit = (n: number, unit: string | null): string => `${fmtQty(n)} ${unitWord(unit, n)}`;

// One phrase for the condition across every surface that shows it. Kept in sync
// with UNIT_BREAK_SHORT in the frontend's chartNotes — two spellings of "mixed
// units" in one product is how a dispatcher ends up thinking they're two
// different problems.
const UNIT_BREAK_SHORT = "Mixed units";

// Label for the server-computed reorder verdict. Plain strings, because the row
// is what both the table and the spreadsheet render, and because the health
// filter matches on this text (the in-memory `in` operator, lowercased).
const HEALTH_LABEL: Record<string, string> = {
	critical: "Reorder now",
	warning: "Watch",
	healthy: "Healthy",
	unknown: "No signal",
};

const stockStatusLabel = (status: string | null): string => {
	switch (status) {
		case "out_of_stock":
			return "Out of Stock";
		case "low":
			return "Low Stock";
		case "sufficient":
			return "Sufficient";
		default:
			return "No Alert";
	}
};

type JobRaw = Awaited<ReturnType<typeof getJobsReport>>[number];
type InvoiceRaw = Awaited<ReturnType<typeof getInvoicesReport>>[number];
type ClientRaw = Awaited<ReturnType<typeof getClientsReport>>[number];
type InventoryRaw = Awaited<ReturnType<typeof getInventoryReport>>[number];
type PaymentRaw = Awaited<ReturnType<typeof getPaymentsReport>>[number];
type QuoteRaw = Awaited<ReturnType<typeof getQuoteFunnelReport>>["quotes"][number];
type TaxRaw = Awaited<ReturnType<typeof getTaxLiabilityReport>>[number];
type ForecastRaw = Awaited<ReturnType<typeof getInventoryReorderForecast>>["rows"][number];
type ReceivableRaw = Awaited<ReturnType<typeof getAgedReceivablesByClient>>[number];
type RetentionRaw = Awaited<ReturnType<typeof getClientRetentionReport>>[number];
type ClvRaw = Awaited<ReturnType<typeof getClientLifetimeValueReport>>[number];
type ClientDiscountRaw = Awaited<ReturnType<typeof getClientDiscountsReport>>[number];
type FieldAddedRaw = Awaited<ReturnType<typeof getFieldAddedRevenueReport>>["rows"][number];
type RecurringRaw = Awaited<ReturnType<typeof getRecurringRevenueReport>>["plans"][number];
type FtfrRaw = Awaited<ReturnType<typeof getFirstTimeFixReport>>[number];
type LineItemTypeRaw = Awaited<ReturnType<typeof getRevenueByLineItemType>>[number];
type RevenueLineItemRaw = Awaited<ReturnType<typeof getRevenueLineItemsReport>>["rows"][number];
type ProjectRaw = Awaited<ReturnType<typeof getProjectsReport>>[number];
type CogsByJobRow = Awaited<ReturnType<typeof getCogsByJobReport>>["rows"][number];
type CogsByItemRow = Awaited<ReturnType<typeof getCogsByItemReport>>["rows"][number];

const jobRow = (job: JobRaw): ReportRow => ({
	id: job.id,
	jobNumber: job.jobNumber,
	name: job.name,
	clientName: job.clientName,
	status: job.status,
	priority: job.priority,
	jobType: job.jobType,
	source: job.source,
	address: job.address || "—",
	createdAt: fmtDate(job.createdAt),
	completedAt: fmtDate(job.completedAt),
	cancelledAt: fmtDate(job.cancelledAt),
	estimatedTotal: job.estimatedTotal ?? "—",
	actualTotal: job.actualTotal ?? "—",
	variance: job.variance ?? "—",
	subtotal: job.subtotal,
	taxAmount: job.taxAmount,
	discountAmount: job.discountAmount ?? "—",
	visitCount: job.visitCount,
});

const ftfrRow = (job: FtfrRaw): ReportRow => ({
	id: job.id,
	jobNumber: job.jobNumber,
	name: job.name,
	clientName: job.clientName,
	completedAt: fmtDate(job.completedAt),
	visitCount: job.visitCount,
	firstTimeFix: job.firstTimeFix ? "Yes" : "No",
});

const invoiceRow = (inv: InvoiceRaw): ReportRow => ({
	id: inv.id,
	invoiceNumber: inv.invoiceNumber,
	clientName: inv.clientName,
	status: inv.status,
	issueDate: fmtDate(inv.issueDate),
	dueDate: fmtDate(inv.dueDate),
	paidAt: fmtDate(inv.paidAt),
	sentAt: fmtDate(inv.sentAt),
	total: inv.total,
	amountPaid: inv.amountPaid,
	balanceDue: inv.balanceDue,
	subtotal: inv.subtotal,
	taxAmount: inv.taxAmount,
	daysOverdue: inv.daysOverdue,
	qbSyncStatus: inv.qbSyncStatus,
});

const clientRow = (c: ClientRaw): ReportRow => ({
	id: c.id,
	name: c.name,
	status: c.status,
	taxExempt: c.taxExempt,
	primaryContact: c.primaryContact || "—",
	email: c.email || "—",
	phone: c.phone || "—",
	address: c.address || "—",
	contactCount: c.contactCount,
	taxGroup: c.taxGroup || "—",
	taxRate: c.taxRate != null ? c.taxRate * 100 : "—",
	lifetimeRevenue: c.lifetimeRevenue,
	openBalance: c.openBalance,
	jobCount: c.jobCount,
	invoiceCount: c.invoiceCount,
	createdAt: fmtDate(c.createdAt),
	lastActivity: fmtDate(c.lastActivity),
});

const inventoryRow = (item: InventoryRaw): ReportRow => ({
	id: item.id,
	itemName: item.name,
	sku: item.sku ?? "—",
	category: item.category ?? "—",
	status: item.isActive ? "Active" : "Discontinued",
	description: item.description || "—",
	quantity: item.quantity,
	fleetQty: item.fleetQty,
	totalQty: item.totalQty,
	fleetStandard: item.fleetStandard,
	lowStockThreshold: item.lowStockThreshold ?? "—",
	// The catalog label, not the stored code — "Feet", not "ft". Shaped here so
	// the on-screen table and the SQL export agree; the client no longer maps it.
	unit: item.unit ? unitDisplay(item.unit).label : "—",
	stockStatus: stockStatusLabel(item.stockStatus),
	cost: item.cost ?? "—",
	unitPrice: item.unitPrice ?? "—",
	assetValue: item.assetValue ?? "—",
	// null is a WITHHELD total (the item's consumption spans a unit change), and
	// 0 is a real answer here — so it reads as unknown rather than as zero.
	qtyUsed: item.qtyUsed ?? "—",
	location: item.location || "—",
	tags: item.tags?.map((t) => t.label).join(", ") || "—",
	altIds: item.altIds?.join(", ") || "—",
	updatedAt: fmtDate(item.updatedAt),
});

const quoteRow = (q: QuoteRaw): ReportRow => ({
	id: q.quoteId,
	quoteNumber: q.quoteNumber,
	title: q.title,
	clientName: q.clientName,
	status: q.status,
	source: q.source,
	total: q.total,
	createdAt: fmtDate(q.createdAt),
	issuedAt: fmtDate(q.issuedAt),
	sentAt: fmtDate(q.sentAt),
	viewedAt: fmtDate(q.viewedAt),
	approvedAt: fmtDate(q.approvedAt),
	daysToApprove: q.daysToApprove ?? "—",
});

const paymentRow = (p: PaymentRaw): ReportRow => ({
	id: p.paymentId,
	_invoiceId: p.invoiceId,
	invoiceNumber: p.invoiceNumber,
	clientName: p.clientName,
	method: p.method || "—",
	recordedBy: p.recordedBy ?? "—",
	note: p.note || "—",
	amount: p.amount,
	paidAt: fmtDate(p.paidAt),
	qbSynced: p.qbSynced ? "Synced" : "Not synced",
});

const taxRow = (r: TaxRaw): ReportRow => ({
	id: r.rateKey,
	jurisdiction: r.jurisdiction,
	rateName: r.rateName,
	rate: r.rate,
	taxableBase: r.taxableBase,
	taxCollected: r.taxCollected,
	invoiceCount: r.invoiceCount,
});

// Shaped here rather than on the page because this report is paginated,
// filtered and exported server-side: `POST /reports/export/server` runs `load`
// + the in-memory filter and never sees the client's mappers, so any column the
// table shows but this doesn't simply exports blank.
const forecastRow = (r: ForecastRaw): ReportRow => ({
	id: r.itemId,
	item: r.itemName,
	sku: r.sku ?? "—",
	category: r.category ?? "—",
	onHand: withUnit(r.currentQuantity, r.unit),
	warehouse: fmtQty(r.warehouseQuantity),
	vehicles: fmtQty(r.vehicleQuantity),
	reorderPoint: r.lowStockThreshold != null ? fmtQty(r.lowStockThreshold) : "—",
	// Three outcomes, three strings. `null` is a WITHHELD rate — the item's
	// consumption spans a unit change, so `each` and `box` totals were never
	// added — and it must not print as "0.00/day", which is a real and different
	// answer this same column gives.
	avgDailyUsage:
		r.avgDailyUsage == null
			? UNIT_BREAK_SHORT
			: r.avgDailyUsage > 0
				? `${r.avgDailyUsage.toFixed(2)}/day`
				: "—",
	// Rounded: a runway printed to two decimals implies a precision an averaged
	// rate over the window doesn't have.
	daysOfStock: r.daysOfStock != null ? `${Math.round(r.daysOfStock)}d` : "—",
	// `~` because this is a projection off an average rate, not a date anything
	// is scheduled for. ReorderHealthCard hedges the same way.
	projectedStockout: r.projectedStockoutDate ? `~${fmtDate(r.projectedStockoutDate)}` : "—",
	health: HEALTH_LABEL[r.severity] ?? HEALTH_LABEL.unknown,
	// Not columns in the table — carried for the export, whose reader can't see
	// the page's window badge. The catalog label, not the stored code: a
	// spreadsheet reader gets "Feet", not "ft".
	unit: unitDisplay(r.unit).label,
	observedDays: r.observedDays,
	qtyConsumed: r.qtyConsumed ?? UNIT_BREAK_SHORT,
	// Who to buy it from. A "~" marks a vendor INFERRED from the last purchase
	// rather than one anybody chose — the report may suggest, but it must not
	// pass a guess off as a decision.
	buyFrom: r.preferredSupplierName
		? r.vendorSource === "preferred"
			? r.preferredSupplierName
			: `~${r.preferredSupplierName}`
		: "—",
	// Export-only, like unit/observedDays above: the part number you actually
	// order by, and what closing the gap to the reorder point would cost.
	vendorSku: r.vendorSku ?? "—",
	estimatedCost:
		r.estimatedShortfallCost != null && r.shortfallQty != null
			? `$${r.estimatedShortfallCost.toFixed(2)} (${fmtQty(r.shortfallQty)} @ ${r.priceSource})`
			: "—",
});

const receivableRow = (r: ReceivableRaw): ReportRow => ({
	id: r.clientId,
	clientName: r.clientName,
	bucket0_30: r.bucket0_30,
	bucket31_60: r.bucket31_60,
	bucket61_90: r.bucket61_90,
	bucket90plus: r.bucket90plus,
	disputed: r.disputed,
	total: r.total,
});

const retentionRow = (r: RetentionRaw): ReportRow => ({
	id: r.id,
	name: r.name,
	primaryContact: r.primaryContact || "—",
	email: r.email || "—",
	phone: r.phone || "—",
	lastActivity: fmtDate(r.lastActivityAt),
	lifetimeRevenue: r.lifetimeRevenue,
	jobCount: r.jobCount,
});

const clvRow = (r: ClvRaw): ReportRow => ({
	id: r.id,
	name: r.name,
	primaryContact: r.primaryContact || "—",
	firstPurchaseAt: fmtDate(r.firstPurchaseAt),
	tenureMonths: r.tenureMonths,
	jobCount: r.jobCount,
	invoiceCount: r.invoiceCount,
	lifetimeRevenue: r.lifetimeRevenue,
	avgInvoiceValue: r.avgInvoiceValue,
});

const clientDiscountRow = (r: ClientDiscountRaw): ReportRow => ({
	id: r.clientId,
	clientName: r.clientName,
	invoiceCount: r.invoiceCount,
	totalBilled: r.totalBilled,
	totalDiscount: r.totalDiscount,
	discountRate: r.discountRate,
	avgDiscount: r.avgDiscount,
});

const fieldAddedRow = (r: FieldAddedRaw): ReportRow => ({
	id: r.techId,
	technician: r.techName,
	itemCount: r.itemCount,
	jobCount: r.jobCount,
	fieldAddedRevenue: r.fieldAddedRevenue,
	avgPerItem: r.avgPerItem,
});

const BILLING_BASIS_LABELS: Record<string, string> = {
	fixed_amount: "Fixed Amount",
	plan_line_items: "Plan Line Items",
	visit_actuals: "Visit Actuals",
	invoice: "Invoice",
	none: "—",
};

const recurringPlanRow = (r: RecurringRaw): ReportRow => ({
	id: r.planId,
	name: r.name,
	clientName: r.clientName,
	status: r.status,
	billingBasis: BILLING_BASIS_LABELS[r.billingBasis] ?? r.billingBasis,
	perPeriodAmount: r.perPeriodAmount ?? "—",
	monthlyValue: r.monthlyValue,
	nextInvoiceAt: fmtDate(r.nextInvoiceAt),
	lastInvoicedAt: fmtDate(r.lastInvoicedAt),
	occCompleted: r.occCompleted,
	occSkipped: r.occSkipped,
});

const lineItemTypeRow = (r: LineItemTypeRaw): ReportRow => ({
	id: r.itemType,
	label: r.label,
	revenue: r.revenue,
	lineCount: r.lineCount,
	pctOfTotal: r.pctOfTotal,
});

const revenueLineItemRow = (r: RevenueLineItemRaw): ReportRow => ({
	id: r.id,
	_invoiceId: r.invoiceId,
	invoiceNumber: r.invoiceNumber,
	clientName: r.clientName,
	issueDate: fmtDate(r.issueDate),
	name: r.name,
	description: r.description || "—",
	quantity: r.quantity,
	unitPrice: r.unitPrice,
	total: r.total,
	itemType: r.itemType,
});

const projectRow = (p: ProjectRaw): ReportRow => ({
	id: p.id,
	projectNumber: p.projectNumber,
	name: p.name,
	clientName: p.clientName,
	status: p.status,
	priority: p.priority,
	managerName: p.managerName ?? "—",
	address: p.address || "—",
	budget: p.budget ?? "—",
	startsAt: fmtDate(p.startsAt),
	targetEndAt: fmtDate(p.targetEndAt),
	createdAt: fmtDate(p.createdAt),
	completedAt: fmtDate(p.completedAt),
	cancelledAt: fmtDate(p.cancelledAt),
	estimatedTotal: p.estimatedTotal ?? "—",
	actualTotal: p.actualTotal ?? "—",
	variance: p.variance ?? "—",
	jobCount: p.jobCount,
})

const cogsByJobRow = (r: CogsByJobRow): ReportRow => ({
	id: r.id,
	jobNumber: r.jobNumber,
	name: r.name,
	clientName: r.clientName,
	status: r.status,
	totalCogs: r.totalCogs ?? "—",
	costCoverage: r.costCoverage,
	itemCount: r.itemCount,
	qtyConsumed: r.qtyConsumed,
	lastConsumedAt: fmtDate(r.lastConsumedAt),
});

const cogsByItemRow = (r: CogsByItemRow): ReportRow => ({
	id: r.id,
	itemName: r.name,
	sku: r.sku ?? "—",
	category: r.category ?? "—",
	unit: r.unit,
	quantity: r.quantity,
	totalCogs: r.totalCogs ?? "—",
	avgUnitCost: r.avgUnitCost ?? "—",
	costCoverage: r.costCoverage,
	qtyConsumed: r.qtyConsumed,
	jobCount: r.jobCount,
	lastConsumedAt: fmtDate(r.lastConsumedAt),
});

const mapPage = <T>(
	r: { rows: T[]; total: number; page: number; pageSize: number; summary?: Record<string, unknown> } | null,
	fn: (row: T) => ReportRow,
) => r && { ...r, rows: r.rows.map(fn) };

export const REPORT_DEFINITIONS: Record<string, ReportDefinition> = {
	jobs: {
		load: async (orgId, q) => ({
			rows: (await getJobsReport(q.startDate, q.endDate, orgId)).map(jobRow),
		}),
		loadPage: async (orgId, q, params) =>
			mapPage(await getJobsReportPage(q.startDate, q.endDate, orgId, params), jobRow),
	},
	"first-time-fix": {
		load: async (orgId, q) => ({
			rows: (await getFirstTimeFixReport(q.startDate, q.endDate, orgId)).map(ftfrRow),
		}),
		filteredSummary: (rows) => {
			const completedJobs = rows.length;
			const firstTimeFix = rows.filter((r) => r.firstTimeFix === "Yes").length;
			const repeatVisit = completedJobs - firstTimeFix;
			const ftfrPercent = completedJobs ? round2((firstTimeFix / completedJobs) * 100) : 0;
			return { completedJobs, firstTimeFix, repeatVisit, ftfrPercent };
		},
	},
	invoices: {
		load: async (orgId, q) => ({
			rows: (await getInvoicesReport(q.startDate, q.endDate, orgId)).map(invoiceRow),
		}),
		loadPage: async (orgId, q, params) =>
			mapPage(await getInvoicesReportPage(q.startDate, q.endDate, orgId, params), invoiceRow),
	},
	clients: {
		load: async (orgId, q) => {
			let raw = await getClientsReport(orgId);
			if (q.startDate || q.endDate) {
				const gte = q.startDate ? reportInstant(q.startDate).getTime() : -Infinity;
				const lte = q.endDate ? reportInstant(q.endDate).getTime() : Infinity;
				raw = raw.filter((c) => {
					const t = new Date(c.createdAt).getTime();
					return t >= gte && t <= lte;
				});
			}
			return { rows: raw.map(clientRow) };
		},
	},
	inventory: {
		load: async (orgId, q) => ({
			rows: (
				await getInventoryReport(orgId, {
					from: q.startDate ? reportInstant(q.startDate) : undefined,
					to: q.endDate ? reportInstant(q.endDate) : undefined,
					includeInactive: q.includeInactive ?? true,
				})
			).map(inventoryRow),
		}),
		loadPage: async (orgId, q, params) =>
			mapPage(
				await getInventoryReportPage(
					orgId,
					{
						from: q.startDate ? reportInstant(q.startDate) : undefined,
						to: q.endDate ? reportInstant(q.endDate) : undefined,
						includeInactive: q.includeInactive ?? true,
					},
					params,
				),
				inventoryRow,
			),
	},
	quotes: {
		load: async (orgId, q) => {
			const funnel = await getQuoteFunnelReport(q.startDate, q.endDate, orgId);
			return {
				rows: funnel.quotes.map(quoteRow),
				summary: {
					funnel: funnel.funnel,
					winRate: funnel.winRate,
					avgDaysToApprove: funnel.avgDaysToApprove,
					valueWon: funnel.valueWon,
					valueLost: funnel.valueLost,
					bySource: funnel.bySource,
				},
			};
		},
		loadPage: async (orgId, q, params) => {
			const page = await getQuoteRowsPage(q.startDate, q.endDate, orgId, params);
			if (!page) return null;
			const summary = await getQuoteFunnelSummary(q.startDate, q.endDate, orgId);
			return {
				rows: page.rows.map(quoteRow),
				total: page.total,
				page: page.page,
				pageSize: page.pageSize,
				summary,
			};
		},
	},
	payments: {
		load: async (orgId, q) => ({
			rows: (await getPaymentsReport(q.startDate, q.endDate, orgId)).map(paymentRow),
		}),
		loadPage: async (orgId, q, params) =>
			mapPage(await getPaymentsReportPage(q.startDate, q.endDate, orgId, params), paymentRow),
		filteredSummary: (rows) => {
			const total = rows.reduce((s, r) => s + num(r.amount), 0);
			const count = rows.length;
			const byMethodMap = new Map<string, { amount: number; count: number }>();
			for (const r of rows) {
				const method = r.method === "—" || !r.method ? "Unspecified" : String(r.method);
				const bucket = byMethodMap.get(method) ?? { amount: 0, count: 0 };
				bucket.amount += num(r.amount);
				bucket.count++;
				byMethodMap.set(method, bucket);
			}
			return {
				totalCollected: total,
				count,
				avg: count > 0 ? total / count : 0,
				byMethod: [...byMethodMap.entries()]
					.map(([method, b]) => ({ method, ...b }))
					.sort((a, b) => b.amount - a.amount),
			};
		},
	},
	"tax-liability": {
		load: async (orgId, q) => ({
			rows: (await getTaxLiabilityReport(q.startDate, q.endDate, orgId)).map(taxRow),
		}),
		filteredSummary: (rows) => ({
			taxableBase: round2(rows.reduce((s, r) => s + num(r.taxableBase), 0)),
			taxCollected: round2(rows.reduce((s, r) => s + num(r.taxCollected), 0)),
			invoiceCount: rows.reduce((s, r) => s + num(r.invoiceCount), 0),
		}),
	},
	"reorder-forecast": {
		load: async (orgId, q) => {
			const { rows, truncated } = await getInventoryReorderForecast(orgId, {
				lookbackDays: q.lookbackDays ?? 90,
			});
			// chartRows is the FULL unfiltered set: the page's severity tiles and
			// runway chart are org-wide statements, so they can't be rebuilt from
			// whichever page the dispatcher happens to be on.
			return { rows: rows.map(forecastRow), summary: { chartRows: rows, truncated } };
		},
	},
	"client-retention": {
		load: async (orgId, q) => ({
			rows: (
				await getClientRetentionReport(orgId, { lookbackDays: q.lookbackDays ?? 180 })
			).map(retentionRow),
		}),
	},
	"client-lifetime-value": {
		load: async (orgId) => ({
			rows: (await getClientLifetimeValueReport(orgId)).map(clvRow),
		}),
		filteredSummary: (rows) => {
			const clientCount = rows.length;
			const totalLifetimeRevenue = round2(rows.reduce((s, r) => s + num(r.lifetimeRevenue), 0));
			const avgClv = clientCount ? round2(totalLifetimeRevenue / clientCount) : 0;
			return { clientCount, totalLifetimeRevenue, avgClv };
		},
	},
	"aged-receivables-by-client": {
		load: async (orgId) => ({
			rows: (await getAgedReceivablesByClient(orgId)).map(receivableRow),
		}),
		filteredSummary: (rows) => ({
			bucket0_30: round2(rows.reduce((s, r) => s + num(r.bucket0_30), 0)),
			bucket31_60: round2(rows.reduce((s, r) => s + num(r.bucket31_60), 0)),
			bucket61_90: round2(rows.reduce((s, r) => s + num(r.bucket61_90), 0)),
			bucket90plus: round2(rows.reduce((s, r) => s + num(r.bucket90plus), 0)),
			disputed: round2(rows.reduce((s, r) => s + num(r.disputed), 0)),
			total: round2(rows.reduce((s, r) => s + num(r.total), 0)),
		}),
	},
	"client-discounts": {
		load: async (orgId, q) => ({
			rows: (await getClientDiscountsReport(q.startDate, q.endDate, orgId)).map(
				clientDiscountRow,
			),
		}),
		filteredSummary: (rows) => {
			const clientCount = rows.length;
			const totalDiscount = round2(rows.reduce((s, r) => s + num(r.totalDiscount), 0));
			const totalBilled = round2(rows.reduce((s, r) => s + num(r.totalBilled), 0));
			const avgDiscountRate = totalBilled > 0 ? round2((totalDiscount / totalBilled) * 100) : 0;
			return { clientCount, totalDiscount, totalBilled, avgDiscountRate };
		},
	},
	"recurring-revenue": {
		load: async (orgId, q) => {
			const report = await getRecurringRevenueReport(q.startDate, q.endDate, orgId);
			return {
				rows: report.plans.map(recurringPlanRow),
				summary: {
					mrr: report.mrr,
					arr: report.arr,
					activePlans: report.activePlans,
					pausedPlans: report.pausedPlans,
					newPlans: report.newPlans,
					churnedPlans: report.churnedPlans,
					churnedMrr: report.churnedMrr,
					completionRate: report.completionRate,
					skipRate: report.skipRate,
					trend: report.trend,
				},
			};
		},
	},
	"field-added-revenue": {
		load: async (orgId, q) => {
			const { rows, orgVisitRevenue, fieldAddedItemCount, truncated, trend } =
				await getFieldAddedRevenueReport(q.startDate, q.endDate, orgId);
			// fieldAddedItems is the distinct item count from the controller. It is
			// not recomputed in filteredSummary: a per-tech itemCount credits a split
			// item to every tech on the visit, so summing rows double-counts, and the
			// per-tech rows carry no item ids to dedupe by.
			return {
				rows: rows.map(fieldAddedRow),
				summary: { orgVisitRevenue, fieldAddedItems: fieldAddedItemCount, truncated, trend },
			};
		},
		filteredSummary: (rows) => {
			const totalFieldAddedRevenue = round2(rows.reduce((s, r) => s + num(r.fieldAddedRevenue), 0));
			const top = rows.reduce<ReportRow | null>(
				(best, r) => (!best || num(r.fieldAddedRevenue) > num(best.fieldAddedRevenue) ? r : best),
				null,
			);
			return {
				technicianCount: rows.length,
				totalFieldAddedRevenue,
				topTechnician: top ? String(top.technician) : "—",
			};
		},
	},
	"revenue-by-line-item-type": {
		load: async (orgId, q) => ({
			rows: (await getRevenueByLineItemType(q.startDate, q.endDate, orgId)).map(lineItemTypeRow),
		}),
		filteredSummary: (rows) => ({
			totalRevenue: round2(rows.reduce((s, r) => s + num(r.revenue), 0)),
			totalLineItems: rows.reduce((s, r) => s + num(r.lineCount), 0),
		}),
	},
	"revenue-line-items": {
		load: async (orgId, q) => {
			const { rows, truncated } = await getRevenueLineItemsReport(q.startDate, q.endDate, orgId);
			return { rows: rows.map(revenueLineItemRow), summary: { truncated } };
		},
		loadPage: async (orgId, q, params) =>
			mapPage(
				await getRevenueLineItemsReportPage(q.startDate, q.endDate, orgId, params),
				revenueLineItemRow,
			),
	},
	projects: {
		load: async (orgId, q) => ({
			rows: (await getProjectsReport(q.startDate, q.endDate, orgId)).map(projectRow)
		}),
		loadPage: async (orgId, q, params) => 
			mapPage(await getProjectsReportPage(q.startDate, q.endDate, orgId, params), projectRow),
	},
	"cogs-by-job": {
		load: async (orgId, q) => {
			const { rows, truncated, trend } = await getCogsByJobReport(q.startDate, q.endDate, orgId);
			return { rows: rows.map(cogsByJobRow), summary: { truncated, trend } };
		},
		filteredSummary: (rows) => ({
			totalCogs: round2(rows.reduce((s, r) => s + num(r.totalCogs), 0)),
			jobCount: rows.length,
			jobsMissingCostData: rows.filter(r => r.costCoverage !== "Full").length,
		}),
	},
	"cogs-by-item": { 
		load: async (orgId, q) => {
			const { rows, truncated, trend } = await getCogsByItemReport(q.startDate, q.endDate, orgId);
			return { rows: rows.map(cogsByItemRow), summary: { truncated, trend } };
		},
		filteredSummary: (rows) => ({
			totalCogs: round2(rows.reduce((s, r) => s + num(r.totalCogs), 0)),
			itemCount: rows.length,
			itemsMissingCostData: rows.filter(r => r.costCoverage !== "Full").length,
		}),
	},
	"job-profitability": {
		load: async (orgId, q) => {
			const { rows, truncated } = await getJobProfitabilityReport(q.startDate, q.endDate, orgId);
			return { rows, summary: { truncated } };
		},
		filteredSummary: (rows) => ({
			totalProfit: round2(rows.reduce((s, r) => s + num(r.profit), 0)),
			jobCount: rows.length,
		}),
		// Rows key on jobId, so the default "every key but id" fallback makes job
		// UUIDs searchable and a search for "500" match a revenue figure. This is
		// not new policy — it makes the in-memory path obey the same "only text
		// columns are searchable" rule the SQL path already has.
		searchKeys: ["jobNumber", "jobName", "clientName"],
	}
};

// A loadPage report resolves search in SQL, so an in-memory searchKeys list would
// only apply to the fallback path and silently diverge from it. Fail at import
// rather than serve two different search behaviours for one report.
for (const [key, def] of Object.entries(REPORT_DEFINITIONS)) {
	if (def.searchKeys && def.loadPage)
		throw new Error(
			`report "${key}" sets both searchKeys and loadPage — searchKeys is only valid on reports without a SQL pushdown path`,
		);
}

export const getReportDefinition = (key: string): ReportDefinition | undefined =>
	REPORT_DEFINITIONS[key];
