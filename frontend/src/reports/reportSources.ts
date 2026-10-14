import { z } from "zod";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ColumnOption } from "../hooks/useColumnVisibility";
import type { Paginated, ReportCategoryId, ReportFetchParams, ReportRowRecord } from "../types/reports";
import {
	useInventoryReportQuery,
	useJobsReportQuery,
	useInvoicesReportQuery,
	useClientsReportQuery,
	usePaymentsReportQuery,
	useQuoteFunnelQuery,
	useProjectsReportQuery,
} from "../hooks/useReports";

export type ColumnType = "text" | "number" | "date" | "currency";

export interface ReportColumnDef {
	key: string;
	label: string;
	type: ColumnType;
	defaultVisible?: boolean;
}

export interface ReportColumnCategory {
	id: string;
	label: string;
	columns: ReportColumnDef[];
}

export interface ReportRows {
	rows: ReportRowRecord[];
	total: number;
	page: number;
	pageSize: number;
	hasMore: boolean;
	isLoading: boolean;
	isFetching: boolean;
	error: Error | null;
}

const toReportRows = (result: UseQueryResult<Paginated, Error>): ReportRows => ({
	rows: (result.data?.rows ?? []) as ReportRowRecord[],
	total: result.data?.total ?? 0,
	page: result.data?.page ?? 0,
	pageSize: result.data?.pageSize ?? 0,
	hasMore: result.data?.hasMore ?? false,
	isLoading: result.isLoading,
	isFetching: result.isFetching,
	error: result.error ?? null,
});

export interface ReportSource {
	id: string;
	label: string;
	description: string;
	// Financial or Operational or Technician or Client
	category: ReportCategoryId;
	dateKey?: string;
	serverDateFilter?: boolean;
	categories: ReportColumnCategory[];
	useRows: (params: ReportFetchParams) => ReportRows;
}

function allColumnDefs(source: ReportSource): ReportColumnDef[] {
	return source.categories.flatMap((c) => c.columns);
}

export function sourceColumnOptions(source: ReportSource): ColumnOption[] {
	return allColumnDefs(source).map((c) => ({ key: c.key, label: c.label }));
}

export function comparableFieldOptions(source: ReportSource, excludeKey: string): ColumnOption[] {
	return allColumnDefs(source)
		.filter((c) => (c.type === "number" || c.type === "currency") && c.key !== excludeKey)
		.map((c) => ({ key: c.key, label: c.label }));
}

export function sourceDefaultHidden(source: ReportSource): string[] {
	return allColumnDefs(source)
		.filter((c) => c.defaultVisible === false)
		.map((c) => c.key);
}

export function sourceColumnType(source: ReportSource, key: string): ColumnType {
	return allColumnDefs(source).find((c) => c.key === key)?.type ?? "text";
}

export function toNumber(value: unknown): number {
	if (typeof value === "number") return value;
	const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ""));
	return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function toTime(value: unknown): number {
	const parsed = new Date(String(value)).getTime();
	return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function compareValues(a: unknown, b: unknown, type: ColumnType): number {
	if (type === "number" || type === "currency") {
		return toNumber(a) - toNumber(b);
	}
	if (type === "date") {
		return toTime(a) - toTime(b);
	}
	return String(a ?? "").localeCompare(String(b ?? ""));
}

export const filterOperatorSchema = z.enum([
	"contains",
	"equals",
	"eq",
	"gt",
	"lt",
	"gte",
	"lte",
	"before",
	"after",
	"between",
	"in_last_days",
	"in",
	"is_empty",
	"not_empty",
]);

export type FilterOperator = z.infer<typeof filterOperatorSchema>;

export const isFilterOperator = (value: string): value is FilterOperator =>
	filterOperatorSchema.safeParse(value).success;

export type FilterJoin = "and" | "or";

export const filterConditionSchema = z.object({
	id: z.string(),
	columnKey: z.string(),
	operator: filterOperatorSchema,
	value: z.string(),
	value2: z.string().optional(),
	valueKind: z.enum(["literal", "field"]).optional(),
});

export type FilterCondition = z.infer<typeof filterConditionSchema>;

const VALUELESS_OPERATORS: readonly FilterOperator[] = ["is_empty", "not_empty"];

export function isConditionActive(condition: FilterCondition): boolean {
	if (!condition.columnKey) return false;
	if (VALUELESS_OPERATORS.includes(condition.operator)) return true;
	if (condition.operator === "between")
		return condition.value.trim() !== "" && (condition.value2 ?? "").trim() !== "";
	return condition.value.trim() !== "";
}

export function operatorsForType(type: ColumnType): { value: FilterOperator; label: string }[] {
	if (type === "number" || type === "currency") {
		return [
			{ value: "eq", label: "=" },
			{ value: "gt", label: ">" },
			{ value: "lt", label: "<" },
			{ value: "gte", label: "≥" },
			{ value: "lte", label: "≤" },
			{ value: "is_empty", label: "Is empty" },
			{ value: "not_empty", label: "Is not empty" },
		];
	}
	if (type === "date") {
		return [
			{ value: "before", label: "Before" },
			{ value: "after", label: "After" },
			{ value: "between", label: "Between" },
			{ value: "in_last_days", label: "In last (days)" },
			{ value: "is_empty", label: "Is empty" },
			{ value: "not_empty", label: "Is not empty" },
		];
	}
	return [
		{ value: "contains", label: "Contains" },
		{ value: "equals", label: "Equals" },
		{ value: "is_empty", label: "Is empty" },
		{ value: "not_empty", label: "Is not empty" },
	];
}

// Sources map null-ish cells to an em dash, so treat it as empty too.
function isEmptyCell(cell: unknown): boolean {
	if (cell == null) return true;
	const text = String(cell).trim();
	return text === "" || text === "—";
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function matchesCondition(
	row: ReportRowRecord,
	source: ReportSource,
	condition: FilterCondition,
): boolean {
	const type = sourceColumnType(source, condition.columnKey);
	const cell = row[condition.columnKey];
	const isField = condition.valueKind === "field";
	const operand = isField ? row[condition.value] : condition.value;

	if (condition.operator === "is_empty") return isEmptyCell(cell);
	if (condition.operator === "not_empty") return !isEmptyCell(cell);

	if (type === "number" || type === "currency") {
		const target = isField
			? toNumber(operand)
			: parseFloat(condition.value.replace(/[^0-9.-]/g, ""));
		if (!Number.isFinite(target)) return true;
		const cellNum = toNumber(cell);
		if (condition.operator === "gte") return cellNum >= target;
		if (condition.operator === "lte") return cellNum <= target;
		if (condition.operator === "gt") return cellNum > target;
		if (condition.operator === "lt") return cellNum < target;
		return cellNum === target;
	}

	if (type === "date") {
		const cellTime = toTime(cell);
		if (condition.operator === "between") {
			const start = new Date(condition.value).getTime();
			const end = new Date(condition.value2 ?? "").getTime() + DAY_MS - 1;
			if (!Number.isFinite(start) || !Number.isFinite(end)) return true;
			return cellTime >= start && cellTime <= end;
		}
		if (condition.operator === "in_last_days") {
			const days = parseFloat(condition.value);
			if (!Number.isFinite(days)) return true;
			return cellTime >= Date.now() - days * DAY_MS;
		}
		const target = isField ? toTime(operand) : new Date(condition.value).getTime();
		if (!Number.isFinite(target)) return true;
		if (condition.operator === "after") return cellTime > target;
		return cellTime < target;
	}

	const cellText = String(cell ?? "").toLowerCase();
	if (condition.operator === "in") {
		const options = String(operand ?? "")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
		if (options.length === 0) return true;
		return options.includes(cellText);
	}
	const target = String(operand ?? "").toLowerCase();
	if (condition.operator === "equals") return cellText === target;
	return cellText.includes(target);
}

const inventorySource: ReportSource = {
	id: "inventory",
	label: "Inventory",
	description: "Current stock levels, pricing, and item details",
	category: "operational",
	serverDateFilter: true,
	categories: [
		{
			id: "item",
			label: "Item",
			columns: [
				{ key: "itemName", label: "Item Name", type: "text" },
				{ key: "sku", label: "SKU", type: "text" },
				{ key: "category", label: "Category", type: "text" },
				{ key: "status", label: "Status", type: "text" },
				{ key: "description", label: "Description", type: "text", defaultVisible: false },
			],
		},
		{
			id: "stock",
			label: "Stock",
			columns: [
				{ key: "quantity", label: "Warehouse Qty", type: "number" },
				{ key: "fleetQty", label: "Fleet Qty", type: "number" },
				{ key: "totalQty", label: "Total Quantity", type: "number" },
				{
					key: "fleetStandard",
					label: "Required Fleet Standard",
					type: "number",
					defaultVisible: false,
				},
				{
					key: "lowStockThreshold",
					label: "Reorder Point",
					type: "number",
					defaultVisible: false,
				},
				{ key: "unit", label: "Unit", type: "text", defaultVisible: false },
				{ key: "stockStatus", label: "Stock Status", type: "text" },
			],
		},
		{
			id: "valuation",
			label: "Valuation",
			columns: [
				{ key: "cost", label: "Unit Cost", type: "currency" },
				{ key: "unitPrice", label: "Billing Price", type: "currency" },
				{ key: "assetValue", label: "Total Asset Value", type: "currency" },
			],
		},
		{
			id: "usage",
			label: "Usage",
			columns: [{ key: "qtyUsed", label: "Quantity Used", type: "number" }],
		},
		{
			id: "details",
			label: "Details",
			columns: [
				{ key: "location", label: "Location", type: "text" },
				{ key: "tags", label: "Tags", type: "text", defaultVisible: false },
				{ key: "altIds", label: "Alt IDs", type: "text", defaultVisible: false },
				{ key: "updatedAt", label: "Last Updated", type: "date" },
			],
		},
	],
	useRows: (params) => toReportRows(useInventoryReportQuery(params)),
};

const jobsSource: ReportSource = {
	id: "jobs",
	label: "Jobs",
	description: "Job status, revenue, and completion across the service pipeline",
	category: "operational",
	serverDateFilter: true,
	categories: [
		{
			id: "job",
			label: "Job",
			columns: [
				{ key: "jobNumber", label: "Job #", type: "text" },
				{ key: "name", label: "Name", type: "text" },
				{ key: "clientName", label: "Client", type: "text" },
				{ key: "status", label: "Status", type: "text" },
				{ key: "priority", label: "Priority", type: "text" },
				{ key: "jobType", label: "Type", type: "text" },
				{ key: "source", label: "Source", type: "text" },
				{ key: "address", label: "Address", type: "text", defaultVisible: false },
			],
		},
		{
			id: "dates",
			label: "Dates",
			columns: [
				{ key: "createdAt", label: "Created", type: "date" },
				{ key: "completedAt", label: "Completed", type: "date" },
				{ key: "cancelledAt", label: "Cancelled", type: "date", defaultVisible: false },
			],
		},
		{
			id: "financials",
			label: "Financials",
			columns: [
				{ key: "estimatedTotal", label: "Estimated Total", type: "currency" },
				{ key: "actualTotal", label: "Actual Total", type: "currency" },
				{ key: "variance", label: "Variance", type: "currency" },
				{ key: "subtotal", label: "Subtotal", type: "currency", defaultVisible: false },
				{ key: "taxAmount", label: "Tax", type: "currency", defaultVisible: false },
				{ key: "discountAmount", label: "Discount", type: "currency", defaultVisible: false },
			],
		},
		{
			id: "activity",
			label: "Activity",
			columns: [{ key: "visitCount", label: "Visits", type: "number" }],
		},
	],
	useRows: (params) => toReportRows(useJobsReportQuery(params)),
};

const invoicesSource: ReportSource = {
	id: "invoices",
	label: "Invoices",
	description: "Outstanding balances, payments, and aging across invoices",
	category: "financial",
	serverDateFilter: true,
	categories: [
		{
			id: "invoice",
			label: "Invoice",
			columns: [
				{ key: "invoiceNumber", label: "Invoice #", type: "text" },
				{ key: "clientName", label: "Client", type: "text" },
				{ key: "status", label: "Status", type: "text" },
			],
		},
		{
			id: "dates",
			label: "Dates",
			columns: [
				{ key: "issueDate", label: "Created", type: "date" },
				{ key: "dueDate", label: "Due", type: "date" },
				{ key: "paidAt", label: "Paid", type: "date", defaultVisible: false },
				{ key: "sentAt", label: "Sent", type: "date", defaultVisible: false },
			],
		},
		{
			id: "amounts",
			label: "Amounts",
			columns: [
				{ key: "total", label: "Total", type: "currency" },
				{ key: "amountPaid", label: "Paid", type: "currency" },
				{ key: "balanceDue", label: "Balance Due", type: "currency" },
				{ key: "subtotal", label: "Subtotal", type: "currency", defaultVisible: false },
				{ key: "taxAmount", label: "Tax", type: "currency", defaultVisible: false },
			],
		},
		{
			id: "aging",
			label: "Aging",
			columns: [{ key: "daysOverdue", label: "Days Overdue", type: "number" }],
		},
		{
			id: "sync",
			label: "Sync",
			columns: [
				{ key: "qbSyncStatus", label: "QuickBooks Sync", type: "text", defaultVisible: false },
			],
		},
	],
	useRows: (params) => toReportRows(useInvoicesReportQuery(params)),
};

const clientsSource: ReportSource = {
	id: "clients",
	label: "Clients",
	description: "Client activity, lifetime revenue, and outstanding balances",
	category: "client",
	dateKey: "createdAt",
	categories: [
		{
			id: "client",
			label: "Client",
			columns: [
				{ key: "name", label: "Client", type: "text" },
				{ key: "status", label: "Status", type: "text" },
				{ key: "taxExempt", label: "Tax Exempt", type: "text" },
			],
		},
		{
			id: "contact",
			label: "Contact",
			columns: [
				{ key: "primaryContact", label: "Primary Contact", type: "text" },
				{ key: "email", label: "Email", type: "text" },
				{ key: "phone", label: "Phone", type: "text" },
				{ key: "address", label: "Address", type: "text", defaultVisible: false },
				{ key: "contactCount", label: "Contacts", type: "number", defaultVisible: false },
			],
		},
		{
			id: "profile",
			label: "Profile",
			columns: [
				{ key: "taxGroup", label: "Tax Group", type: "text", defaultVisible: false },
				{ key: "taxRate", label: "Tax Rate (%)", type: "number", defaultVisible: false },
			],
		},
		{
			id: "financials",
			label: "Financials",
			columns: [
				{ key: "lifetimeRevenue", label: "Lifetime Revenue", type: "currency" },
				{ key: "openBalance", label: "Open Balance", type: "currency" },
			],
		},
		{
			id: "activity",
			label: "Activity",
			columns: [
				{ key: "jobCount", label: "Jobs", type: "number" },
				{ key: "invoiceCount", label: "Invoices", type: "number" },
				{ key: "createdAt", label: "Created", type: "date" },
				{ key: "lastActivity", label: "Last Activity", type: "date" },
			],
		},
	],
	useRows: (params) => toReportRows(useClientsReportQuery(params)),
};

const quotesSource: ReportSource = {
	id: "quotes",
	label: "Quotes",
	description: "Quote pipeline, conversion timing, and outcomes",
	category: "operational",
	serverDateFilter: true,
	categories: [
		{
			id: "quote",
			label: "Quote",
			columns: [
				{ key: "quoteNumber", label: "Quote #", type: "text" },
				{ key: "title", label: "Title", type: "text" },
				{ key: "clientName", label: "Client", type: "text" },
				{ key: "status", label: "Status", type: "text" },
				{ key: "source", label: "Source", type: "text" },
			],
		},
		{
			id: "dates",
			label: "Dates",
			columns: [
				{ key: "createdAt", label: "Created", type: "date" },
				{ key: "issuedAt", label: "Marked Created", type: "date", defaultVisible: false },
				{ key: "sentAt", label: "Sent", type: "date" },
				{ key: "viewedAt", label: "Viewed", type: "date", defaultVisible: false },
				{ key: "approvedAt", label: "Approved", type: "date" },
			],
		},
		{
			id: "amounts",
			label: "Amounts",
			columns: [{ key: "total", label: "Total", type: "currency" }],
		},
		{
			id: "conversion",
			label: "Conversion",
			columns: [{ key: "daysToApprove", label: "Days to Approve", type: "number" }],
		},
	],
	useRows: (params) => toReportRows(useQuoteFunnelQuery(params)),
};

const paymentsSource: ReportSource = {
	id: "payments",
	label: "Payments",
	description: "Payments received by invoice, method, and recorder",
	category: "financial",
	serverDateFilter: true,
	categories: [
		{
			id: "payment",
			label: "Payment",
			columns: [
				{ key: "invoiceNumber", label: "Invoice #", type: "text" },
				{ key: "clientName", label: "Client", type: "text" },
				{ key: "method", label: "Method", type: "text" },
				{ key: "recordedBy", label: "Recorded By", type: "text" },
				{ key: "note", label: "Note", type: "text", defaultVisible: false },
			],
		},
		{
			id: "amounts",
			label: "Amounts",
			columns: [{ key: "amount", label: "Amount", type: "currency" }],
		},
		{
			id: "dates",
			label: "Dates",
			columns: [{ key: "paidAt", label: "Paid", type: "date" }],
		},
		{
			id: "sync",
			label: "Sync",
			columns: [
				{ key: "qbSynced", label: "QuickBooks Sync", type: "text", defaultVisible: false },
			],
		},
	],
	useRows: (params) => toReportRows(usePaymentsReportQuery(params)),
};

const projectsSource: ReportSource = {
	id: "projects",
	label: "Projects",
	description: "Multi-job projects, their managers, schedule, and rolled-up job totals",
	category: "operational",
	serverDateFilter: true,
	categories: [
		{
			id: "project",
			label: "Project",
			columns: [
				{ key: "projectNumber", label: "Project #", type: "text" },
				{ key: "name", label: "Name", type: "text" },
				{ key: "clientName", label: "Client", type: "text" },
				{ key: "status", label: "Status", type: "text" },
				{ key: "priority", label: "Priority", type: "text" },
				{ key: "managerName", label: "Manager", type: "text" },
				{ key: "address", label: "Address", type: "text", defaultVisible: false },
			],
		},
		{
			id: "dates",
			label: "Dates",
			columns: [
				{ key: "startsAt", label: "Starts", type: "date" },
				{ key: "targetEndAt", label: "Target End", type: "date" },
				{ key: "createdAt", label: "Created", type: "date", defaultVisible: false },
				{ key: "completedAt", label: "Completed", type: "date" },
				{ key: "cancelledAt", label: "Cancelled", type: "date", defaultVisible: false },
			],
		},
		{
			id: "financials",
			label: "Financials",
			columns: [
				{ key: "budget", label: "Budget", type: "currency" },
				{ key: "estimatedTotal", label: "Estimated Total", type: "currency" },
				{ key: "actualTotal", label: "Actual Total", type: "currency" },
				{ key: "variance", label: "Variance", type: "currency" },
			],
		},
		{
			id: "activity",
			label: "Activity",
			columns: [{ key: "jobCount", label: "Jobs", type: "number" }],
		},
	],
	useRows: (params) => toReportRows(useProjectsReportQuery(params)),
}

export const REPORT_SOURCES: ReportSource[] = [
	inventorySource,
	jobsSource,
	invoicesSource,
	clientsSource,
	quotesSource,
	paymentsSource,
	projectsSource,
];

export function getReportSource(id: string): ReportSource | undefined {
	return REPORT_SOURCES.find((s) => s.id === id);
}
