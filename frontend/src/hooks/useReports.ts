import { useMemo } from "react";
import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useDebouncedValue } from "./useDebouncedValue";
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

// Only searchTerms is debounced, so paging and filters stay instant. It's
// debounced as a string because pages rebuild the array every render.
const usePaginatedReport = (
	key: string[],
	fetch: (params: ReportFetchParams) => Promise<Paginated>,
	params: ReportFetchParams,
	enabled = true,
): UseQueryResult<Paginated, Error> => {
	const terms = useDebouncedValue(JSON.stringify(params.searchTerms ?? null));
	const effective = useMemo(
		() => ({ ...params, searchTerms: (JSON.parse(terms) as string[] | null) ?? undefined }),
		[params, terms],
	);
	return useQuery({
		queryKey: ["reports", ...key, effective],
		queryFn: () => fetch(effective),
		placeholderData: keepPreviousData,
		enabled,
	});
};

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

export const useReorderForecastQuery = (params: ReportFetchParams) =>
	usePaginatedReport(["reorder-forecast"], reportsApi.getReorderForecast, params);

export const useInventoryReportQuery = (params: ReportFetchParams) =>
	usePaginatedReport(["inventory-full"], reportsApi.getInventoryReport, params);

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

export const useAgedReceivablesByClientQuery = (params: ReportFetchParams) =>
	usePaginatedReport(["aged-receivables", "by-client"], reportsApi.getAgedReceivablesByClient, params);

export const useTaxLiabilityReportQuery = (params: ReportFetchParams) =>
	usePaginatedReport(["tax-liability"], reportsApi.getTaxLiabilityReport, params);

export const useJobsReportQuery = (params: ReportFetchParams) =>
	usePaginatedReport(["jobs"], reportsApi.getJobsReport, params);

export const useInvoicesReportQuery = (params: ReportFetchParams) =>
	usePaginatedReport(["invoices"], reportsApi.getInvoicesReport, params);

export const useClientsReportQuery = (params: ReportFetchParams) =>
	usePaginatedReport(["clients"], reportsApi.getClientsReport, params);

export const useClientRetentionQuery = (params: ReportFetchParams) =>
	usePaginatedReport(["client-retention"], reportsApi.getClientRetentionReport, params);

export const useClientLifetimeValueQuery = (params: ReportFetchParams) =>
	usePaginatedReport(["client-ltv"], reportsApi.getClientLifetimeValueReport, params);

export const useClientDiscountsQuery = (params: ReportFetchParams) =>
	usePaginatedReport(["client-discounts"], reportsApi.getClientDiscountsReport, params);

export const useFieldAddedRevenueQuery = (params: ReportFetchParams) =>
	usePaginatedReport(["field-added-revenue"], reportsApi.getFieldAddedRevenueReport, params);

export const useRecurringRevenueQuery = (params: ReportFetchParams) =>
	usePaginatedReport(["recurring-revenue"], reportsApi.getRecurringRevenueReport, params);

export const usePaymentsReportQuery = (params: ReportFetchParams) =>
	usePaginatedReport(["payments"], reportsApi.getPaymentsReport, params);

export const useRevenueByLineItemTypeQuery = (params: ReportFetchParams) =>
	usePaginatedReport(["revenue-by-line-item-type"], reportsApi.getRevenueByLineItemTypeReport, params);

export const useRevenueLineItemsQuery = (params: ReportFetchParams) =>
	usePaginatedReport(["revenue-line-items"], reportsApi.getRevenueLineItemsReport, params);

export const useQuoteFunnelQuery = (params: ReportFetchParams) =>
	usePaginatedReport(["quote-funnel"], reportsApi.getQuoteFunnelReport, params);

export const useFirstTimeFixQuery = (params: ReportFetchParams) =>
	usePaginatedReport(["first-time-fix"], reportsApi.getFirstTimeFixReport, params);

export const useProjectsReportQuery = (params: ReportFetchParams) =>
	usePaginatedReport(["projects"], reportsApi.getProjectsReport, params);

export const useCogsByJobReportQuery = (params: ReportFetchParams, enabled = true) =>
	usePaginatedReport(["cogs-by-job"], reportsApi.getCogsByJobReport, params, enabled);

export const useCogsByItemReportQuery = (params: ReportFetchParams, enabled = true) =>
	usePaginatedReport(["cogs-by-item"], reportsApi.getCogsByItemReport, params, enabled);

export const useTechnicianScorecardQuery = (
	startDate?: string,
	endDate?: string,
): UseQueryResult<TechScorecardVisitRow[], Error> => {
	return useQuery({
		queryKey: ["reports", "technician-scorecard", startDate, endDate],
		queryFn: () => reportsApi.getTechnicianScorecard(startDate, endDate),
	});
};

export const useJobProfitabilityReportQuery = (params: ReportFetchParams, enabled = true) =>
	usePaginatedReport(["job-profitability"], reportsApi.getJobProfitabilityReport, params, enabled);

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