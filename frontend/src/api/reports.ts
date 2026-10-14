import { api } from "./axiosClient";
import { triggerDownload } from "../util/download";
import type { ApiResponse } from "../types/api";
import type {
	OverviewResponse,
	RevenueYTDResponse,
	RevenueByJobTypeResponse,
	LeadsBySourceResponse,
	UnscheduledRevenueResponse,
	QuotePipelineResponse,
	ArrivalPerformanceResponse,
	MileageReportVisit,
	TimesheetReportEntry,
	AgedReceivablesResponse,
	JobBacklogResponse,
	TechScorecardVisitRow,
	PageSummaryResponse,
	Paginated,
	ReportFetchParams,
} from "../types/reports";

const buildReportParams = (p: ReportFetchParams): Record<string, string> => {
	const q: Record<string, string> = {};
	if (p.startDate) q.startDate = p.startDate;
	if (p.endDate) q.endDate = p.endDate;
	if (p.search) q.search = p.search;
	if (p.searchTerms?.length) q.searchTerms = JSON.stringify(p.searchTerms);
	if (p.conditions?.length) q.conditions = JSON.stringify(p.conditions);
	if (p.join) q.join = p.join;
	if (p.sortKey) q.sortKey = p.sortKey;
	if (p.sortDir) q.sortDir = p.sortDir;
	if (p.sortType) q.sortType = p.sortType;
	if (p.page != null) q.page = String(p.page);
	if (p.limit != null) q.limit = String(p.limit);
	if (p.include_inactive) q.include_inactive = "true";
	if (p.lookbackDays != null) q.lookbackDays = String(p.lookbackDays);
	return q;
};

const fetchPaginated = async (
	path: string,
	params: ReportFetchParams,
	errorMessage: string,
): Promise<Paginated> => {
	const response = await api.get<ApiResponse<Paginated>>(path, {
		params: buildReportParams(params),
	});
	if (!response.data.data) throw new Error(errorMessage);
	return response.data.data;
};

// ============================================================================
// REPORTS API
// ============================================================================

export const getOverview = async (
	startDate: string,
	endDate: string,
): Promise<OverviewResponse> => {
	const params: Record<string, string> = { startDate, endDate };

	const response = await api.get<ApiResponse<OverviewResponse>>(
		"/reports/overview",
		{ params },
	);

	if (!response.data.data) {
		throw new Error("Failed to fetch overview metrics");
	}

	return response.data.data;
};

export const getRevenueYTD = async (
	year?: number,
): Promise<RevenueYTDResponse> => {
	const params: Record<string, string> = {};
	if (year) params.year = String(year);

	const response = await api.get<ApiResponse<RevenueYTDResponse>>(
		"/reports/revenue-ytd",
		{ params },
	);

	if (!response.data.data) {
		throw new Error("Failed to fetch revenue data");
	}

	return response.data.data;
};

export const getRevenueByJobType = async (
	startDate: string,
	endDate: string,
): Promise<RevenueByJobTypeResponse> => {
	const params: Record<string, string> = { startDate, endDate };

	const response = await api.get<ApiResponse<RevenueByJobTypeResponse>>(
		"/reports/revenue-by-job-type",
		{ params },
	);

	if (!response.data.data) {
		throw new Error("Failed to fetch revenue by job type");
	}

	return response.data.data;
};

export const getLeadsBySource = async (
	startDate: string,
	endDate: string,
): Promise<LeadsBySourceResponse> => {
	const params: Record<string, string> = { startDate, endDate };

	const response = await api.get<ApiResponse<LeadsBySourceResponse>>(
		"/reports/leads-by-source",
		{ params },
	);

	if (!response.data.data) {
		throw new Error("Failed to fetch leads by source");
	}

	return response.data.data;
};

export const getUnscheduledRevenue = async (): Promise<UnscheduledRevenueResponse> => {
	const response = await api.get<ApiResponse<UnscheduledRevenueResponse>>(
		"/reports/unscheduled-revenue",
	);

	if (!response.data.data) {
		throw new Error("Failed to fetch unscheduled revenue");
	}

	return response.data.data;
};

export const getQuotePipeline = async (
	startDate: string,
	endDate: string,
): Promise<QuotePipelineResponse> => {
	const params: Record<string, string> = { startDate, endDate };
	const response = await api.get<ApiResponse<QuotePipelineResponse>>(
		"/reports/quote-pipeline",
		{ params },
	);

	if (!response.data.data) {
		throw new Error("Failed to fetch quote pipeline");
	}

	return response.data.data;
};

export const getArrivalPerformance = async (
	startDate: string,
	endDate: string,
): Promise<ArrivalPerformanceResponse> => {
	const params: Record<string, string> = { startDate, endDate };

	const response = await api.get<ApiResponse<ArrivalPerformanceResponse>>(
		"/reports/arrival-performance",
		{ params },
	);

	if (!response.data.data) {
		throw new Error("Failed to fetch arrival performance");
	}

	return response.data.data;
};

export const getMileageReport = async (
	startDate?: string,
	endDate?: string,
): Promise<MileageReportVisit[]> => {
	const params: Record<string, string> = {};
	if (startDate) params.startDate = startDate;
	if (endDate) params.endDate = endDate;

	const response = await api.get<ApiResponse<MileageReportVisit[]>>(
		"/reports/mileage",
		{ params },
	);
	if (!response.data.data) throw new Error("Failed to fetch mileage report");
	return response.data.data;
};

export const getTimesheetsReport = async (
	startDate?: string,
	endDate?: string,
): Promise<TimesheetReportEntry[]> => {
	const params: Record<string, string> = {};
	if (startDate) params.startDate = startDate;
	if (endDate) params.endDate = endDate;

	const response = await api.get<ApiResponse<TimesheetReportEntry[]>>(
		"/reports/timesheets",
		{ params },
	);
	if (!response.data.data) throw new Error("Failed to fetch timesheets report");
	return response.data.data;
};

export const getReorderForecast = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated(
		"/reports/inventory/reorder-forecast",
		params,
		"Failed to fetch reorder forecast",
	);

export const getInventoryReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated(
		"/reports/inventory/full",
		{ include_inactive: true, ...params },
		"Failed to fetch inventory report",
	);

export const getAgedReceivables = async (): Promise<AgedReceivablesResponse> => {
	const response = await api.get<ApiResponse<AgedReceivablesResponse>>(
		"/reports/receivables/aging",
	);

	if (!response.data.data) {
		throw new Error("Failed to fetch aged receivables");
	}

	return response.data.data;
};

export const getJobBacklog = async (): Promise<JobBacklogResponse> => {
	const response = await api.get<ApiResponse<JobBacklogResponse>>("/reports/job-backlog");

	if (!response.data.data) {
		throw new Error("Failed to fetch job backlog");
	}

	return response.data.data;
};

export const getAgedReceivablesByClient = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated(
		"/reports/receivables/aging/by-client",
		params,
		"Failed to fetch aged receivables by client",
	);

export const getTaxLiabilityReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated("/reports/tax-liability", params, "Failed to fetch tax liability report");

export const getJobsReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated("/reports/jobs", params, "Failed to fetch jobs report");

export const getInvoicesReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated("/reports/invoices", params, "Failed to fetch invoices report");

export const getClientsReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated("/reports/clients", params, "Failed to fetch clients report");

export const getClientRetentionReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated("/reports/clients/retention", params, "Failed to fetch client retention report");

export const getClientLifetimeValueReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated(
		"/reports/clients/lifetime-value",
		params,
		"Failed to fetch client lifetime value report",
	);

export const getClientDiscountsReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated(
		"/reports/clients/discounts",
		params,
		"Failed to fetch client discounts report",
	);

export const getFieldAddedRevenueReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated(
		"/reports/field-added-revenue",
		params,
		"Failed to fetch field-added revenue report",
	);

export const getRecurringRevenueReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated(
		"/reports/recurring-revenue",
		params,
		"Failed to fetch recurring revenue report",
	);

export const getPaymentsReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated("/reports/payments", params, "Failed to fetch payments report");

export const getRevenueByLineItemTypeReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated(
		"/reports/revenue-by-line-item-type",
		params,
		"Failed to fetch revenue by line item type report",
	);

export const getRevenueLineItemsReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated("/reports/revenue-line-items", params, "Failed to fetch revenue line items");

export const getQuoteFunnelReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated("/reports/quote-funnel", params, "Failed to fetch quote funnel report");

export const getFirstTimeFixReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated("/reports/first-time-fix", params, "Failed to fetch first-time fix report");

export const getProjectsReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated("/reports/projects", params, "Failed to fetch projects report");

export const getCogsByJobReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated("/reports/cogs-by-job", params, "Failed to fetch cost of goods sold by job report");

export const getCogsByItemReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated("/reports/cogs-by-item", params, "Failed to fetch cost of goods sold by item report");

export const getJobProfitabilityReport = (params: ReportFetchParams = {}): Promise<Paginated> =>
	fetchPaginated("/reports/job-profitability", params, "Failed to fetch job profitability report");

export const getTechnicianScorecard = async (
	startDate?: string,
	endDate?: string,
): Promise<TechScorecardVisitRow[]> => {
	const params: Record<string, string> = {};
	if (startDate) params.startDate = startDate;
	if (endDate) params.endDate = endDate;

	const response = await api.get<ApiResponse<TechScorecardVisitRow[]>>(
		"/reports/technician-scorecard",
		{ params },
	);

	if (!response.data.data) {
		throw new Error("Failed to fetch technician scorecard");
	}

	return response.data.data;
};

export interface ExportColumn {
	key: string;
	label: string;
}

export interface ExportReportArgs {
	filename: string;
	columns: ExportColumn[];
	rows: Array<Record<string, unknown>>;
	sheetName?: string;
}

export const exportReport = async ({
	filename,
	columns,
	rows,
	sheetName,
}: ExportReportArgs): Promise<void> => {
	const response = await api.post(
		"/reports/export",
		{ filename, sheetName, columns, rows },
		{ responseType: "blob" },
	);
	triggerDownload(response.data as Blob, filename);
};

export const getPageSummary = async (
	page: string,
	startDate?: string,
	endDate?: string,
	groupBy?: string,
): Promise<PageSummaryResponse> => {
	const params: Record<string, string> = {};
	params.page = page;
	if (startDate) params.startDate = startDate;
	if (endDate) params.endDate = endDate;
	if (groupBy) params.groupBy = groupBy;
	const response = await api.get("/reports/page-summary", { params });
	if (!response.data.data){
		throw new Error("Failed to fetch page summary");
	}
	return response.data.data;
}

export interface ExportServerArgs {
	report: string;
	filename: string;
	columns: ExportColumn[];
	sheetName?: string;
	params?: ReportFetchParams;
}

// Server-side export: sends the report key + active filters (not the rows) so the
// backend regenerates the full filtered set for the sheet.
export const exportReportServer = async ({
	report,
	filename,
	columns,
	sheetName,
	params = {},
}: ExportServerArgs): Promise<void> => {
	// Export regenerates the full filtered set, so page/limit are irrelevant (the
	// server ignores them); include_inactive is forwarded under the API's camelCase.
	const response = await api.post(
		"/reports/export/server",
		{ report, filename, sheetName, columns, ...params, includeInactive: params.include_inactive },
		{ responseType: "blob" },
	);
	triggerDownload(response.data as Blob, filename);
};
