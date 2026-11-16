import z from "zod";
import { authed, envelope, errorEnvelope, json, moduleOff } from "./shared.js";

// ===============================================================================================================================
// Reports
// ===============================================================================================================================

const paymentReportRow = z
	.object({
		id: z.uuid(),
		_invoiceId: z.uuid(),
		invoiceNumber: z.string(),
		clientName: z.string(),
		method: z.string().describe('"—" when none'),
		recordedBy: z.string().describe('"—" when unknown'),
		note: z.string().describe('"—" when empty'),
		amount: z.number(),
		paidAt: z.string().describe('Display date, e.g. "Jan 5, 2026"'),
		_paidAtIso: z.iso.datetime(),
		qbSynced: z.enum(["Synced", "Not synced"]),
	})
	.meta({ id: "PaymentReportRow" });

const dateRange = z.object({
	startDate: z
		.string()
		.optional()
		.describe("ISO instant, or YYYY-MM-DD for the start of that UTC day"),
	endDate: z
		.string()
		.optional()
		.describe("ISO instant, or YYYY-MM-DD for the end of that UTC day"),
});
const pageQuery = z.object({
	search: z.string().optional().describe("Text search over the text columns"),
	searchTerms: z.string().optional().describe("JSON array of search strings"),
	conditions: z
		.string()
		.optional()
		.describe(
			"JSON array of `{ id, columnKey, operator, value, value2? }` filter conditions",
		),
	join: z.enum(["and", "or"]).optional().describe("How `conditions` combine"),
	sortKey: z.string().optional().describe("Column to sort by"),
	sortDir: z.enum(["asc", "desc"]).optional(),
	sortType: z.enum(["text", "number", "date", "currency"]).optional(),
	page: z.int().min(0).optional().describe("Zero-based page, default 0"),
	limit: z.int().min(1).max(200).optional().describe("Page size, default 50"),
});

authed("get", "/reports/payments", "Reports", "view_reports", {
	summary: "Payments report",
	description:
		"Requires the `view_reports` permission. One page of recorded payments, newest first, with a summary over every matching row. If any paging/filter parameter is invalid, all of them are ignored.",
	request: {
		query: dateRange.extend(pageQuery.shape),
	},
	responses: {
		200: json(
			envelope(
				z.object({
					rows: z.array(paymentReportRow),
					total: z
						.number()
						.describe("Matching rows across all pages"),
					page: z.number(),
					pageSize: z.number(),
					hasMore: z.boolean(),
					summary: z.object({
						totalCollected: z.number(),
						count: z.number(),
						avg: z.number(),
						byMethod: z.array(
							z.object({
								method: z.string(),
								amount: z.number(),
								count: z.number(),
							}),
						),
					}),
				}),
			),
			"Payments page",
		),
		400: json(
			errorEnvelope,
			"`startDate` or `endDate` is not a date (`VALIDATION_ERROR`)",
		),
	},
});

// Every report below runs through the same page/filter engine as the payments report.
const reportPageData = envelope(
	z.object({
		rows: z.array(z.record(z.string(), z.unknown())),
		total: z.number().describe("Matching rows across all pages"),
		page: z.number(),
		pageSize: z.number(),
		hasMore: z.boolean(),
		summary: z
			.record(z.string(), z.unknown())
			.optional()
			.describe("Totals over every matching row, not just this page"),
	}),
);
const badDate = json(
	errorEnvelope,
	"`startDate` or `endDate` is not a date (`VALIDATION_ERROR`)",
);
const reportPage = (
	path: string,
	summary: string,
	text: string,
	opts: { dated?: boolean; extra?: z.ZodRawShape; module?: string } = {},
) => {
	const dated = opts.dated ?? true;
	authed(
		"get",
		`/reports/${path}`,
		"Reports",
		"view_reports",
		{
			summary,
			description: `Requires the \`view_reports\` permission. ${text} Paged and filtered like \`GET /reports/payments\`; if any paging/filter parameter is invalid, all of them are ignored.`,
			request: {
				query: (dated
					? dateRange.extend(pageQuery.shape)
					: pageQuery
				).extend(opts.extra ?? {}),
			},
			responses: {
				200: json(reportPageData, "Report page"),
				...(dated ? { 400: badDate } : {}),
			},
		},
		opts.module ? moduleOff(opts.module) : undefined,
	);
};
const lookback = (days: number) =>
	z.coerce
		.number()
		.int()
		.optional()
		.describe(`Days of history to look at, default ${days}`);

reportPage(
	"tax-liability",
	"Tax liability report",
	"Tax collected per jurisdiction and rate in the period: `jurisdiction`, `rateName`, `rate`, `taxableBase`, `taxCollected`, `invoiceCount`.",
);
reportPage(
	"jobs",
	"Jobs report",
	"One row per job created in the period: `jobNumber`, `name`, `clientName`, `status`, `priority`, `jobType`, `source`, `address`, dates, `estimatedTotal`, `actualTotal`, `variance`, `subtotal`, `taxAmount`, `discountAmount`, `visitCount`.",
	{ module: "advanced_reporting" },
);
reportPage(
	"invoices",
	"Invoices report",
	"One row per invoice in the period: `invoiceNumber`, `clientName`, `status`, issue/due/sent/paid dates, `total`, `amountPaid`, `balanceDue`, `subtotal`, `taxAmount`, `daysOverdue`, `qbSyncStatus`.",
	{ module: "advanced_reporting" },
);
reportPage(
	"clients",
	"Clients report",
	"One row per client (created in the period, when dates are given): `name`, `status`, `taxExempt`, primary contact and its `email`/`phone`, `address`, `contactCount`, `taxGroup`, `taxRate`, `lifetimeRevenue`, `openBalance`, `jobCount`, `invoiceCount`, `createdAt`, `lastActivity`.",
	{ module: "advanced_reporting" },
);
reportPage(
	"clients/retention",
	"Client retention report",
	"Clients with no activity in the last `lookbackDays` days: `name`, primary contact, `email`, `phone`, `lastActivity`, `lifetimeRevenue`, `jobCount`.",
	{ dated: false, extra: { lookbackDays: lookback(180) } },
);
reportPage(
	"clients/lifetime-value",
	"Client lifetime value report",
	"One row per client: primary contact, `firstPurchaseAt`, `tenureMonths`, `jobCount`, `invoiceCount`, `lifetimeRevenue`, `avgInvoiceValue`. Summary: `clientCount`, `totalLifetimeRevenue`, `avgClv`.",
	{ dated: false },
);
reportPage(
	"clients/discounts",
	"Client discounts report",
	"Discounts given per client in the period: `clientName`, `invoiceCount`, `totalBilled`, `totalDiscount`, `discountRate`, `avgDiscount`. Summary: `clientCount`, `totalDiscount`, `totalBilled`, `avgDiscountRate`.",
);
reportPage(
	"clients/not-invoiced",
	"Work not yet invoiced",
	"Unbilled work per client, split into in-progress, approved and ready-to-bill amounts, with the underlying `items`. Summary: client count, the three totals, and `agedBuckets` (0–30, 31–60, 61–90, 90+ days).",
	{
		dated: false,
		extra: {
			stage: z
				.enum(["in_progress", "approved", "ready"])
				.optional()
				.describe("Only work at this stage"),
		},
	},
);
reportPage(
	"clients/invoice-lifecycle",
	"Invoice payment timing report",
	"Per client, how long invoices took from creation to payment and how late they were, with the underlying `items`. Summary: `clientCount`, `invoiceCount`, `avgCreatedToPaid`, `onTimePct`, `timeBuckets`.",
	{
		extra: {
			paymentStatus: z
				.enum(["open", "paid"])
				.optional()
				.describe("Only open or only paid invoices"),
		},
	},
);
reportPage(
	"purchases-by-supplier",
	"Purchases by supplier report",
	"Spend per supplier in the period, with the underlying purchase `items`. Summary: `supplierCount`, `purchaseCount`, `netSpend`, `fieldSharePct`.",
	{
		extra: {
			source: z
				.enum(["order", "field"])
				.optional()
				.describe("Only purchase orders, or only field purchases"),
		},
	},
);
reportPage(
	"sales-by-product",
	"Sales by product report",
	"Units sold, net revenue and gross profit per catalog item in the period. Summary: `productCount`, `unitsSold`, `netRevenue`, `grossProfit`, `marginPct`, `truncated`.",
);
reportPage(
	"quote-funnel",
	"Quote funnel report",
	"One row per quote in the period: `quoteNumber`, `title`, `clientName`, `status`, `source`, `total`, created/issued/sent/viewed/approved dates, `daysToApprove`. Summary: `funnel`, `winRate`, `avgDaysToApprove`, `valueWon`, `valueLost`, `bySource`.",
	{ module: "quotes" },
);
reportPage(
	"first-time-fix",
	"First-time fix report",
	"Completed jobs in the period and whether one visit was enough: `jobNumber`, `name`, `clientName`, `completedAt`, `visitCount`, `firstTimeFix`.",
);
reportPage(
	"inventory/reorder-forecast",
	"Reorder forecast report",
	"Per item: stock on hand (warehouse and vehicles), reorder point, average daily use over `lookbackDays`, days of stock left, projected stockout date, `health`, and where to buy it. The org-wide version of `GET /inventory/{id}/forecast`.",
	{
		dated: false,
		extra: { lookbackDays: lookback(90) },
		module: "inventory",
	},
);
reportPage(
	"inventory/full",
	"Inventory report",
	"One row per item: `itemName`, `sku`, `category`, `status`, quantities (warehouse, fleet, total), `lowStockThreshold`, `unit`, `stockStatus`, `cost`, `unitPrice`, `assetValue`, `qtyUsed` in the period, `location`, `tags`. Inactive items are always included.",
	{
		module: "inventory",
		extra: {
			include_inactive: z
				.enum(["true"])
				.optional()
				.describe(
					"Has no effect: inactive items are included either way",
				),
		},
	},
);
reportPage(
	"receivables/aging/by-client",
	"Aged receivables by client",
	"Unpaid balances per client by age: `bucket0_30`, `bucket31_60`, `bucket61_90`, `bucket90plus`, `disputed`, `total`. Summary: the same columns summed.",
	{ dated: false },
);
reportPage(
	"recurring-revenue",
	"Recurring revenue report",
	"One row per recurring plan: `name`, `clientName`, `status`, `billingBasis`, `perPeriodAmount`, `monthlyValue`, next/last invoice dates, completed and skipped occurrences. Summary: `mrr`, `arr`, active/paused/new/churned plan counts, `churnedMrr`, `completionRate`, `skipRate`, `trend`.",
	{ module: "recurring_plans" },
);
reportPage(
	"field-added-revenue",
	"Field-added revenue report",
	"Revenue from line items technicians added in the field, per technician: `techName`, `itemCount`, `jobCount`, `fieldAddedRevenue`, `avgPerItem`. Summary: `orgVisitRevenue`, `fieldAddedItems`, `truncated`, `trend`.",
);
reportPage(
	"revenue-by-line-item-type",
	"Revenue by line item type",
	"Invoiced revenue per line item type in the period: `label`, `revenue`, `lineCount`, `pctOfTotal`.",
);
reportPage(
	"revenue-line-items",
	"Invoiced line items report",
	"One row per invoice line in the period: `invoiceNumber`, `clientName`, `issueDate`, `name`, `description`, `quantity`, `unitPrice`, `total`, `itemType`.",
);
reportPage(
	"job-profitability",
	"Job profitability report",
	"Per job in the period: revenue against parts (`cogs`), labor, travel and overhead cost. Summary: the totals, plus org-wide overhead absorption figures.",
	{ module: "advanced_reporting" },
);
reportPage(
	"projects",
	"Projects report",
	"One row per project in the period: `projectNumber`, `name`, `clientName`, `status`, `priority`, `managerName`, `address`, `budget`, dates, `estimatedTotal`, `actualTotal`, `variance`, `jobCount`.",
	{ module: "projects" },
);
reportPage(
	"cogs-by-job",
	"Parts cost by job",
	"Cost of parts used per job in the period: `jobNumber`, `name`, `clientName`, `status`, `totalCogs`, `costCoverage`, `itemCount`, `qtyConsumed`, `lastConsumedAt`. Summary: `truncated`, `trend`.",
	{ module: "advanced_reporting" },
);
reportPage(
	"cogs-by-item",
	"Parts cost by item",
	"Cost of parts used per item in the period: `itemName`, `sku`, `category`, `unit`, `quantity`, `totalCogs`, `avgUnitCost`, `costCoverage`, `qtyConsumed`, `jobCount`, `lastConsumedAt`. Summary: `truncated`, `trend`.",
	{ module: "advanced_reporting" },
);

// Dashboard metrics: one fixed shape each, no paging.
const viewReports = "Requires the `view_reports` permission.";
const requiredRange = z.object({
	startDate: z
		.string()
		.describe("ISO instant, or YYYY-MM-DD for the start of that UTC day"),
	endDate: z
		.string()
		.describe("ISO instant, or YYYY-MM-DD for the end of that UTC day"),
});
const rangeRequired = json(
	errorEnvelope,
	"`startDate` or `endDate` is missing or not a date (`VALIDATION_ERROR`)",
);
const metric = z.object({
	value: z.number(),
	previousValue: z.number(),
	changePercent: z.number(),
});
const amountCount = z.object({ revenue: z.number(), count: z.number().int() });
const metricReport = (
	path: string,
	summary: string,
	text: string,
	data: z.ZodType,
	opts: {
		range?: "required" | "optional" | "none";
		extra?: z.ZodRawShape;
		module?: string;
	} = {},
) => {
	const range = opts.range ?? "required";
	const query =
		range === "required"
			? requiredRange
			: range === "optional"
				? dateRange
				: z.object({});
	authed(
		"get",
		`/reports/${path}`,
		"Reports",
		"view_reports",
		{
			summary,
			description: `${viewReports} ${text}`,
			request: { query: query.extend(opts.extra ?? {}) },
			responses: {
				200: json(envelope(data), summary),
				...(range === "required"
					? { 400: rangeRequired }
					: range === "optional"
						? { 400: badDate }
						: {}),
			},
		},
		opts.module ? moduleOff(opts.module) : undefined,
	);
};

metricReport(
	"overview",
	"Business overview",
	"Headline numbers for the period, each with the value for the same-length period just before it and the change in percent (100 when the previous value is 0 and the current one is above it). `avgResponseTime` is in days; `unscheduledBacklog` is current, with no comparison.",
	z.object({
		periodStart: z.iso.datetime(),
		periodEnd: z.iso.datetime(),
		previousPeriodStart: z.iso.datetime(),
		previousPeriodEnd: z.iso.datetime(),
		grossRevenue: metric,
		avgResponseTime: metric,
		convertedQuotes: metric,
		conversionRate: metric,
		newOneOffJobs: metric,
		newRecurringJobs: metric,
		avgJobValue: metric,
		unscheduledBacklog: metric,
	}),
);
metricReport(
	"revenue-ytd",
	"Revenue by month",
	"Revenue for each month of `year` next to the previous year, plus forecast revenue from scheduled work.",
	z.object({
		data: z.array(
			z.object({
				month: z.string(),
				currentYear: z.number(),
				previousYear: z.number(),
				forecast: z.number(),
			}),
		),
		total: z.number().describe("This year's revenue so far"),
		year: z.number().int(),
	}),
	{
		range: "none",
		extra: {
			year: z.coerce
				.number()
				.int()
				.optional()
				.describe("Defaults to this year"),
		},
	},
);
metricReport(
	"revenue-by-job-type",
	"Revenue by job type",
	"Revenue in the period split into one-time and recurring jobs.",
	z.object({
		data: z.array(
			z.object({
				type: z.enum(["One-Time", "Recurring"]),
				revenue: z.number(),
			}),
		),
		total: z.number(),
	}),
);
metricReport(
	"leads-by-source",
	"Leads by source",
	"Requests received in the period, counted by source.",
	z.object({
		data: z.array(
			z.object({ source: z.string(), count: z.number().int() }),
		),
		total: z.number().int(),
	}),
);
metricReport(
	"unscheduled-revenue",
	"Unscheduled job value",
	"Estimated value of jobs still `Unscheduled`, by how long they've waited: `new`, `warning` (7 days or more) and `critical`.",
	z.object({
		totalRevenue: z.number(),
		jobCount: z.number().int(),
		new: amountCount,
		warning: amountCount,
		critical: amountCount,
	}),
	{ range: "none" },
);
const backlogBucket = z.object({
	count: z.number().int(),
	revenue: z.number(),
});
const backlogRow = z.object({
	fresh: backlogBucket,
	aging: backlogBucket,
	stalled: backlogBucket,
	total: backlogBucket,
});
metricReport(
	"job-backlog",
	"Job backlog",
	"Open jobs (Unscheduled, Scheduled, InProgress) by how long they've sat in their current status: `fresh`, `aging`, `stalled`.",
	z.object({
		statuses: z.array(
			backlogRow.extend({
				status: z.enum(["Unscheduled", "Scheduled", "InProgress"]),
			}),
		),
		totals: backlogRow,
	}),
	{ range: "none" },
);
metricReport(
	"quote-pipeline",
	"Quote pipeline",
	"Value and count of quotes from the period still awaiting a decision, by status.",
	z.object({
		totalRevenue: z.number(),
		quoteCount: z.number().int(),
		draft: amountCount,
		sent: amountCount,
		viewed: amountCount,
		disputed: amountCount,
	}),
	{ module: "quotes" },
);
metricReport(
	"arrival-performance",
	"Arrival performance",
	"Visits in the period by arrival against the scheduled start: early (more than 15 minutes before), on time, or late (more than 30 minutes after).",
	z.object({
		early: z.number().int(),
		onTime: z.number().int(),
		late: z.number().int(),
		total: z.number().int(),
		onTimeRate: z.number(),
	}),
);
metricReport(
	"mileage",
	"Mileage report",
	"One row per visit scheduled in the period, with estimated miles driven there and back.",
	z.array(
		z.object({
			visitId: z.uuid(),
			jobId: z.uuid(),
			jobName: z.string(),
			jobAddress: z.string(),
			clientName: z.string(),
			visitDate: z.iso.datetime(),
			miles: z.number(),
			visitStatus: z.string(),
			technicianNames: z
				.string()
				.describe('Comma-separated, or "Unassigned"'),
		}),
	),
	{ range: "optional" },
);
metricReport(
	"timesheets",
	"Timesheets report",
	"One row per ended shift in the period, with hours split into visit, driving and break time.",
	z.array(
		z.object({
			shiftId: z.uuid(),
			technicianId: z.uuid(),
			technicianName: z.string(),
			startedAt: z.iso.datetime(),
			endedAt: z.iso.datetime(),
			grossHours: z.number(),
			breakHours: z.number(),
			payableHours: z.number(),
			visitHours: z.number(),
			driveHours: z.number(),
			visitCount: z.number().int(),
		}),
	),
	{ range: "optional" },
);
metricReport(
	"technician-scorecard",
	"Technician scorecard",
	"One row per technician per completed visit in the period: arrival, hours worked, and an even share of the visit's total. Group by `techId` for the scorecard.",
	z.array(
		z.object({
			techId: z.uuid(),
			techName: z.string(),
			visitId: z.uuid(),
			jobId: z.uuid(),
			jobName: z.string(),
			clientName: z.string(),
			scheduledStartAt: z.iso.datetime(),
			actualStartAt: z.iso.datetime().nullable(),
			arrival: z.enum(["Early", "On Time", "Late"]).nullable(),
			hoursWorked: z.number(),
			revenueShare: z.number(),
		}),
	),
	{ range: "optional", module: "advanced_reporting" },
);
metricReport(
	"receivables/aging",
	"Aged receivables",
	"Unpaid invoice balances by age (from the due date, or created date if none). Disputed invoices are counted separately but included in `totalOutstanding`.",
	z.object({
		data: z.array(
			z.object({
				bucket: z.enum(["0-30", "31-60", "61-90", "90+"]),
				amount: z.number(),
				count: z.number().int(),
			}),
		),
		disputedTotal: z.number(),
		disputedCount: z.number().int(),
		totalOutstanding: z.number(),
	}),
	{ range: "none" },
);

const summaryPage = z.enum([
	"jobs",
	"quotes",
	"requests",
	"invoices",
	"clients",
	"inventory",
	"projects",
	"recurring_plans",
]);
const stat = z.object({
	label: z.string(),
	value: z.number(),
	format: z.enum(["number", "currency", "percent", "duration"]),
	note: z.string().optional(),
});
const pagePlanRefused = `The page's module isn't in the plan (\`MODULE_NOT_IN_PLAN\`)`;

authed(
	"get",
	"/reports/page-summary",
	"Reports",
	"view_reports",
	{
		summary: "Summary for a list page",
		description: `${viewReports} The stat cards and breakdown chart shown above a list page (jobs, quotes, …) for the period. \`groupBy\` picks the breakdown; one the page doesn't support falls back to its default.`,
		request: {
			query: z.object({
				page: summaryPage,
				startDate: z
					.string()
					.optional()
					.describe("ISO instant with offset, or YYYY-MM-DD"),
				endDate: z
					.string()
					.optional()
					.describe("ISO instant with offset, or YYYY-MM-DD"),
				groupBy: z
					.enum([
						"status",
						"priority",
						"type",
						"qb_sync",
						"tax_exempt",
						"qb_linked",
						"manager",
					])
					.optional(),
			}),
		},
		responses: {
			200: json(
				envelope(
					z.object({
						page: z.string(),
						stats: z.array(stat),
						breakdown: z.array(
							z.object({ label: z.string(), value: z.number() }),
						),
						breakdownLabel: z.string(),
					}),
				),
				"Summary",
			),
			400: json(
				errorEnvelope,
				"Invalid query parameter (`VALIDATION_ERROR`)",
			),
		},
	},
	pagePlanRefused,
);

authed(
	"get",
	"/reports/page-snapshot",
	"Reports",
	"view_reports",
	{
		summary: "Current-state stats for a list page",
		description: `${viewReports} The subtitle stats for a list page, as of now (no period).`,
		request: { query: z.object({ page: summaryPage }) },
		responses: {
			200: json(
				envelope(z.object({ page: z.string(), stats: z.array(stat) })),
				"Snapshot",
			),
			400: json(
				errorEnvelope,
				"Missing or unknown `page` (`VALIDATION_ERROR`)",
			),
		},
	},
	pagePlanRefused,
);

const exportColumns = z
	.array(z.object({ key: z.string().min(1), label: z.string() }))
	.min(1)
	.describe("Which row keys become columns, in order, and their headers");
const xlsxFile = {
	description: "The spreadsheet, as an attachment named `filename`",
	content: {
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
			schema: z.string().meta({ format: "binary" }),
		},
	},
};
const exportBase = z.object({
	filename: z.string().min(1).max(200),
	sheetName: z
		.string()
		.min(1)
		.max(31)
		.optional()
		.describe('Default "Report"'),
	columns: exportColumns,
});

authed("post", "/reports/export", "Reports", "export_reports", {
	summary: "Export rows to a spreadsheet",
	description:
		"Requires the `export_reports` permission. Turns the rows you send into an XLSX file; nothing is read from the database.",
	request: {
		body: {
			content: {
				"application/json": {
					schema: exportBase
						.extend({
							rows: z.array(z.record(z.string(), z.unknown())),
						})
						.meta({ id: "ExportRows" }),
				},
			},
		},
	},
	responses: {
		200: xlsxFile,
		400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
	},
});

authed(
	"post",
	"/reports/export/server",
	"Reports",
	"export_reports",
	{
		summary: "Export a whole report",
		description:
			"Requires the `export_reports` permission. Runs a paged report in full (every page) with the same filters as its table, and returns it as an XLSX file. `report` is the report's key, e.g. `jobs`, `payments`, `client-retention`, `aged-receivables-by-client`. Doesn't check `view_reports`.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: exportBase
							.extend({
								report: z.string().min(1),
								startDate: z.string().optional(),
								endDate: z.string().optional(),
								includeInactive: z.boolean().optional(),
								lookbackDays: z
									.number()
									.int()
									.min(1)
									.optional(),
								paymentStatus: z
									.enum(["open", "paid"])
									.optional(),
								stage: z
									.enum(["approved", "in_progress", "ready"])
									.optional(),
								source: z.enum(["order", "field"]).optional(),
								search: z.string().optional(),
								searchTerms: z.array(z.string()).optional(),
								conditions: z
									.array(z.record(z.string(), z.unknown()))
									.optional(),
								join: z.enum(["and", "or"]).optional(),
								sortKey: z.string().optional(),
								sortDir: z.enum(["asc", "desc"]).optional(),
								sortType: z
									.enum([
										"text",
										"number",
										"date",
										"currency",
									])
									.optional(),
							})
							.meta({ id: "ExportReport" }),
						example: {
							report: "jobs",
							filename: "jobs.xlsx",
							columns: [
								{ key: "jobNumber", label: "Job #" },
								{ key: "clientName", label: "Client" },
							],
							startDate: "2026-01-01",
							endDate: "2026-03-31",
						},
					},
				},
			},
		},
		responses: {
			200: xlsxFile,
			400: json(
				errorEnvelope,
				"Validation failed, unknown `report`, or a date isn't valid (`VALIDATION_ERROR`)",
			),
		},
	},
	"The report's module isn't in the plan (`MODULE_NOT_IN_PLAN`)",
);

// Saved reports and favorites belong to the caller; other users' rows read as not found.
const savedReport = z
	.object({
		id: z.uuid(),
		organization_id: z.uuid(),
		name: z.string(),
		description: z.string().nullable(),
		source: z.string().describe("The report key it was built from"),
		config: z
			.record(z.string(), z.unknown())
			.describe("Columns, filters, sort, grouping and chart"),
		created_by_id: z.uuid().nullable(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
	})
	.meta({ id: "SavedReport" });
const savedConfig = z.object({
	hidden: z.array(z.string()),
	date: z.string(),
	search: z.string(),
	sortKey: z.string(),
	sortDir: z.enum(["asc", "desc"]),
	join: z.enum(["and", "or"]),
	conditions: z.array(z.record(z.string(), z.unknown())),
	groupBy: z.string().optional(),
	aggregates: z
		.array(
			z.object({
				columnKey: z.string(),
				fn: z.enum(["sum", "avg", "count", "min", "max"]),
			}),
		)
		.optional(),
	totalsRow: z.boolean().optional(),
	chart: z
		.object({
			type: z.enum(["bar", "line", "pie"]),
			xKey: z.string(),
			yKey: z.string(),
			yFn: z.enum(["sum", "avg", "count"]),
		})
		.optional(),
});
const savedOff = moduleOff("advanced_reporting");
const savedParams = z.object({ id: z.uuid() });
const savedNotFound = json(
	errorEnvelope,
	"Not found, or saved by another user (`NOT_FOUND`)",
);
const nameTaken = json(
	errorEnvelope,
	"You already have a saved report with this name (`CONFLICT`)",
);
const savedFail = json(
	errorEnvelope,
	"Validation failed, or the database call failed (`VALIDATION_ERROR`)",
);

authed(
	"get",
	"/reports/saved",
	"Reports",
	"view_reports",
	{
		summary: "List my saved reports",
		description: `${viewReports} The caller's own saved reports, last changed first, at most 500.`,
		responses: {
			200: json(
				envelope(z.array(savedReport)),
				"Saved reports (empty array if none)",
			),
			400: savedFail,
		},
	},
	savedOff,
);

authed(
	"post",
	"/reports/saved",
	"Reports",
	"view_reports",
	{
		summary: "Save a report",
		description: `${viewReports} Saves a customized view of a report under a name unique to the caller.`,
		request: {
			body: {
				content: {
					"application/json": {
						schema: z
							.object({
								name: z.string().min(1).max(120),
								source: z
									.string()
									.min(1)
									.describe("Report key, e.g. `jobs`"),
								description: z
									.string()
									.max(500)
									.nullable()
									.optional(),
								config: savedConfig,
							})
							.meta({ id: "CreateSavedReport" }),
					},
				},
			},
		},
		responses: {
			201: json(envelope(savedReport), "Saved"),
			400: savedFail,
			409: nameTaken,
		},
	},
	savedOff,
);

authed(
	"get",
	"/reports/saved/{id}",
	"Reports",
	"view_reports",
	{
		summary: "Get a saved report",
		description: viewReports,
		request: { params: savedParams },
		responses: {
			200: json(envelope(savedReport), "Saved report"),
			400: savedFail,
			404: savedNotFound,
		},
	},
	savedOff,
);

authed(
	"put",
	"/reports/saved/{id}",
	"Reports",
	"view_reports",
	{
		summary: "Update a saved report",
		description: `${viewReports} Send only what changes; \`config\` is replaced whole.`,
		request: {
			params: savedParams,
			body: {
				content: {
					"application/json": {
						schema: z
							.object({
								name: z.string().min(1).max(120).optional(),
								description: z
									.string()
									.max(500)
									.nullable()
									.optional(),
								config: savedConfig.optional(),
							})
							.meta({ id: "UpdateSavedReport" }),
					},
				},
			},
		},
		responses: {
			200: json(envelope(savedReport), "Updated"),
			400: savedFail,
			404: savedNotFound,
			409: nameTaken,
		},
	},
	savedOff,
);

authed(
	"delete",
	"/reports/saved/{id}",
	"Reports",
	"view_reports",
	{
		summary: "Delete a saved report",
		description: viewReports,
		request: { params: savedParams },
		responses: {
			200: json(envelope(z.object({ id: z.uuid() })), "Deleted"),
			400: json(errorEnvelope, "The delete failed (`DELETE_ERROR`)"),
			404: savedNotFound,
		},
	},
	savedOff,
);

const favorite = z
	.object({
		id: z.uuid(),
		organization_id: z.uuid(),
		dispatcher_id: z.uuid().describe("The user who starred it"),
		kind: z.enum(["built_in", "saved"]),
		ref: z
			.string()
			.describe("Report key for `built_in`, saved report id for `saved`"),
		created_at: z.iso.datetime(),
	})
	.meta({ id: "ReportFavorite" });

authed("get", "/reports/favorites", "Reports", "view_reports", {
	summary: "List my favorite reports",
	description: `${viewReports} The caller's starred reports, newest first, at most 500.`,
	responses: {
		200: json(
			envelope(z.array(favorite)),
			"Favorites (empty array if none)",
		),
		400: savedFail,
	},
});

authed("post", "/reports/favorites", "Reports", "view_reports", {
	summary: "Star a report",
	description: `${viewReports} Starring one that's already starred returns the existing favorite (still 201). \`ref\` isn't checked.`,
	request: {
		body: {
			content: {
				"application/json": {
					schema: z
						.object({
							kind: z.enum(["built_in", "saved"]),
							ref: z.string().min(1),
						})
						.meta({ id: "CreateReportFavorite" }),
					example: { kind: "built_in", ref: "job-profitability" },
				},
			},
		},
	},
	responses: {
		201: json(envelope(favorite), "Starred"),
		400: savedFail,
	},
});

authed("delete", "/reports/favorites/{id}", "Reports", "view_reports", {
	summary: "Unstar a report",
	description: viewReports,
	request: { params: savedParams },
	responses: {
		200: json(envelope(z.object({ id: z.uuid() })), "Removed"),
		400: json(errorEnvelope, "The delete failed (`DELETE_ERROR`)"),
		404: json(errorEnvelope, "Not found, or another user's (`NOT_FOUND`)"),
	},
});
