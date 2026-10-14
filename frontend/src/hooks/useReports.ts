import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
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
	Paginated,
	ReportFetchParams,
	PageSummaryResponse,
} from "../types/reports";
import * as reportsApi from "../api/reports";

// ============================================================================
// REPORT QUERIES
// ============================================================================

export const useOverviewQuery = (
	startDate: string,
	endDate: string,
): UseQueryResult<OverviewResponse, Error> => {
	return useQuery({
		queryKey: ["reports", "overview", startDate, endDate],
		queryFn: () => reportsApi.getOverview(startDate, endDate),
		enabled: !!startDate && !!endDate,
	});
};

export const useRevenueYTDQuery = (
	year?: number,
): UseQueryResult<RevenueYTDResponse, Error> => {
	return useQuery({
		queryKey: ["reports", "revenue-ytd", year],
		queryFn: () => reportsApi.getRevenueYTD(year),
	});
};

export const useRevenueByJobTypeQuery = (
	startDate: string,
	endDate: string,
): UseQueryResult<RevenueByJobTypeResponse, Error> => {
	return useQuery({
		queryKey: ["reports", "revenue-by-job-type", startDate, endDate],
		queryFn: () => reportsApi.getRevenueByJobType(startDate, endDate),
		enabled: !!startDate && !!endDate,
	});
};

export const useLeadsBySourceQuery = (
	startDate: string,
	endDate: string,
): UseQueryResult<LeadsBySourceResponse, Error> => {
	return useQuery({
		queryKey: ["reports", "leads-by-source", startDate, endDate],
		queryFn: () => reportsApi.getLeadsBySource(startDate, endDate),
		enabled: !!startDate && !!endDate,
	});
};

export const useUnscheduledRevenueQuery = (): UseQueryResult<UnscheduledRevenueResponse, Error> => {
	return useQuery({
		queryKey: ["reports", "unscheduled-revenue"],
		queryFn: () => reportsApi.getUnscheduledRevenue(),
	});
};

export const useQuotePipelineQuery = (
	startDate: string,
	endDate: string,
): UseQueryResult<QuotePipelineResponse, Error> => {
	return useQuery({
		queryKey: ["reports", "quote-pipeline", startDate, endDate],
		queryFn: () => reportsApi.getQuotePipeline(startDate, endDate),
		enabled: !!startDate && !!endDate,
	});
};

export const useArrivalPerformanceQuery = (
	startDate: string,
	endDate: string,
): UseQueryResult<ArrivalPerformanceResponse, Error> => {
	return useQuery({
		queryKey: ["reports", "arrival-performance", startDate, endDate],
		queryFn: () => reportsApi.getArrivalPerformance(startDate, endDate),
		enabled: !!startDate && !!endDate,
	});
};

export const useMileageReportQuery = (
	startDate?: string,
	endDate?: string,
): UseQueryResult<MileageReportVisit[], Error> => {
	return useQuery({
		queryKey: ["reports", "mileage", startDate, endDate],
		queryFn: () => reportsApi.getMileageReport(startDate, endDate),
	});
};

export const useTimesheetsReportQuery = (
	startDate?: string,
	endDate?: string,
	options?: { enabled?: boolean },
): UseQueryResult<TimesheetReportEntry[], Error> => {
	return useQuery({
		queryKey: ["reports", "timesheets", startDate, endDate],
		queryFn: () => reportsApi.getTimesheetsReport(startDate, endDate),
		enabled: options?.enabled ?? true,
	});
};

export const useReorderForecastQuery = (
	params: ReportFetchParams,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "reorder-forecast", params],
		queryFn: () => reportsApi.getReorderForecast(params),
		placeholderData: keepPreviousData,
	});

export const useInventoryReportQuery = (
	params: ReportFetchParams,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "inventory-full", params],
		queryFn: () => reportsApi.getInventoryReport(params),
		placeholderData: keepPreviousData,
	});

export const useAgedReceivablesQuery = (): UseQueryResult<AgedReceivablesResponse, Error> => {
	return useQuery({
		queryKey: ["reports", "aged-receivables"],
		queryFn: () => reportsApi.getAgedReceivables(),
	});
};

export const useJobBacklogQuery = (): UseQueryResult<JobBacklogResponse, Error> => {
	return useQuery({
		queryKey: ["reports", "job-backlog"],
		queryFn: () => reportsApi.getJobBacklog(),
	});
};

export const useAgedReceivablesByClientQuery = (
	params: ReportFetchParams,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "aged-receivables", "by-client", params],
		queryFn: () => reportsApi.getAgedReceivablesByClient(params),
		placeholderData: keepPreviousData,
	});

export const useTaxLiabilityReportQuery = (
	params: ReportFetchParams,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "tax-liability", params],
		queryFn: () => reportsApi.getTaxLiabilityReport(params),
		placeholderData: keepPreviousData,
	});

export const useJobsReportQuery = (
	params: ReportFetchParams,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "jobs", params],
		queryFn: () => reportsApi.getJobsReport(params),
		placeholderData: keepPreviousData,
	});

export const useInvoicesReportQuery = (
	params: ReportFetchParams,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "invoices", params],
		queryFn: () => reportsApi.getInvoicesReport(params),
		placeholderData: keepPreviousData,
	});

export const useClientsReportQuery = (
	params: ReportFetchParams,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "clients", params],
		queryFn: () => reportsApi.getClientsReport(params),
		placeholderData: keepPreviousData,
	});

export const useClientRetentionQuery = (
	params: ReportFetchParams,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "client-retention", params],
		queryFn: () => reportsApi.getClientRetentionReport(params),
		placeholderData: keepPreviousData,
	});

export const useClientLifetimeValueQuery = (
	params: ReportFetchParams,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "client-ltv", params],
		queryFn: () => reportsApi.getClientLifetimeValueReport(params),
		placeholderData: keepPreviousData,
	});

export const useClientDiscountsQuery = (
	params: ReportFetchParams,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "client-discounts", params],
		queryFn: () => reportsApi.getClientDiscountsReport(params),
		placeholderData: keepPreviousData,
	});

export const useFieldAddedRevenueQuery = (
	params: ReportFetchParams,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "field-added-revenue", params],
		queryFn: () => reportsApi.getFieldAddedRevenueReport(params),
		placeholderData: keepPreviousData,
	});

export const useRecurringRevenueQuery = (
	params: ReportFetchParams,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "recurring-revenue", params],
		queryFn: () => reportsApi.getRecurringRevenueReport(params),
		placeholderData: keepPreviousData,
	});

export const usePaymentsReportQuery = (
	params: ReportFetchParams,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "payments", params],
		queryFn: () => reportsApi.getPaymentsReport(params),
		placeholderData: keepPreviousData,
	});

export const useRevenueByLineItemTypeQuery = (
	params: ReportFetchParams,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "revenue-by-line-item-type", params],
		queryFn: () => reportsApi.getRevenueByLineItemTypeReport(params),
		placeholderData: keepPreviousData,
	});

export const useRevenueLineItemsQuery = (
	params: ReportFetchParams,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "revenue-line-items", params],
		queryFn: () => reportsApi.getRevenueLineItemsReport(params),
		placeholderData: keepPreviousData,
	});

export const useQuoteFunnelQuery = (
	params: ReportFetchParams,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "quote-funnel", params],
		queryFn: () => reportsApi.getQuoteFunnelReport(params),
		placeholderData: keepPreviousData,
	});

export const useFirstTimeFixQuery = (
	params: ReportFetchParams,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "first-time-fix", params],
		queryFn: () => reportsApi.getFirstTimeFixReport(params),
		placeholderData: keepPreviousData,
	});

export const useProjectsReportQuery = (
	params: ReportFetchParams,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "projects", params],
		queryFn: () => reportsApi.getProjectsReport(params),
		placeholderData: keepPreviousData,
	});

export const useCogsByJobReportQuery = (
	params: ReportFetchParams,
	enabled = true
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "cogs-by-job", params],
		queryFn: () => reportsApi.getCogsByJobReport(params),
		placeholderData: keepPreviousData,
		enabled,
	});

export const useCogsByItemReportQuery = (
	params: ReportFetchParams,
	enabled = true
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "cogs-by-item", params],
		queryFn: () => reportsApi.getCogsByItemReport(params),
		placeholderData: keepPreviousData,
		enabled,
	});

export const useTechnicianScorecardQuery = (
	startDate?: string,
	endDate?: string,
): UseQueryResult<TechScorecardVisitRow[], Error> => {
	return useQuery({
		queryKey: ["reports", "technician-scorecard", startDate, endDate],
		queryFn: () => reportsApi.getTechnicianScorecard(startDate, endDate),
	});
};

export const useJobProfitabilityReportQuery = (
	params: ReportFetchParams,
	enabled = true,
): UseQueryResult<Paginated, Error> =>
	useQuery({
		queryKey: ["reports", "job-profitability", params],
		queryFn: () => reportsApi.getJobProfitabilityReport(params),
		placeholderData: keepPreviousData,
		enabled,
	});

export const usePageSummaryQuery = (
	page: string,
	startDate?: string,
	endDate?: string,
	groupBy?: string,
): UseQueryResult<PageSummaryResponse, Error> => {
	return useQuery({
		queryKey: ["reports", "page-summary", page, startDate, endDate, groupBy],
		queryFn: () => reportsApi.getPageSummary(page, startDate, endDate, groupBy),
	});
};