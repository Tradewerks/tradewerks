import AdaptableTable from "../../components/AdaptableTable";
import { useMileageReportQuery } from "../../hooks/useReports";
import { useState, useMemo } from "react";
import { Gauge, ArrowLeft } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { formatDate, camelCaseToRegular } from "../../util/util";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import PageControls from "../../components/ui/PageControls";
import DateRangeFilter from "../../components/ui/DateRangeFilter";
import { parseDateRangeFromParams, matchesDateRange } from "../../util/dateRangeUtils";
import PageHeader from "../../components/ui/PageHeader";
import RefreshReportsButton from "../../components/reports/RefreshReportButton";
import ExportExcelButton from "../../components/reports/ExportExcelButton";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import { exportReport } from "../../api/reports";
import { datedFilename } from "../../util/download";

export default function MileageReportPage() {
	const navigate = useNavigate();
	const location = useLocation();
	const { data: visits, isLoading, error } = useMileageReportQuery();

	const [searchInput, setSearchInput] = useState("");
	const { terms, addTerm, removeTerm, duplicateTerm } = useMultiSearch("search");
	const termsKey = terms.join(" ");

	// URL params
	const queryParams = new URLSearchParams(location.search);
	const techParamRaw = queryParams.get("tech");
	const techParam = techParamRaw ? decodeURIComponent(techParamRaw) : null;
	const dateParamKey = queryParams.get("date");
	const dateParamFrom = queryParams.get("dateFrom");
	const dateParamTo = queryParams.get("dateTo");

	const isSummaryView = techParam === null;

	// Shared date range resolver
	const dateRange = useMemo(() => {
		const _dp = new URLSearchParams();
		if (dateParamKey) _dp.set("date", dateParamKey);
		if (dateParamFrom) _dp.set("dateFrom", dateParamFrom);
		if (dateParamTo) _dp.set("dateTo", dateParamTo);
		return parseDateRangeFromParams(_dp, "date");
	}, [dateParamKey, dateParamFrom, dateParamTo]);

	// ── Summary──────────────────────────────────────────────────────────
	const { summaryDisplay, summaryTotalMiles, summaryVisitCount } = useMemo(() => {
		const dateFiltered = (visits ?? []).filter((v) =>
			dateRange.option === "all"
				? true
				: matchesDateRange(new Date(v.visitDate), dateRange),
		);

		// Per each Technician
		const techMap = new Map<
			string,
			{ totalMiles: number; visitCount: number }
		>();

		for (const v of dateFiltered) {
			const names = v.technicianNames
				.split(", ")
				.map((n) => n.trim())
				.filter(Boolean);
			if (names.length === 0) names.push("Unassigned");
			for (const name of names) {
				const existing = techMap.get(name);
				if (existing) {
					existing.totalMiles += v.miles;
					existing.visitCount += 1;
				} else {
					techMap.set(name, {
						totalMiles: v.miles,
						visitCount: 1,
					});
				}
			}
		}

		// Apply search filter on technician name
		const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;
		let rows = Array.from(techMap.entries()).map(([name, stats]) => ({
			technician: name,
			_totalMilesRaw: stats.totalMiles,
			totalMiles: `${stats.totalMiles.toFixed(1)} mi`,
			visits: stats.visitCount,
			avgMilesPerVisit: `${(stats.totalMiles / stats.visitCount).toFixed(1)} mi`,
		}));

		if (activeTerms.length > 0) {
			rows = rows.filter((r) =>
				activeTerms.every((term) => r.technician.toLowerCase().includes(term.toLowerCase())),
			);
		}

		rows.sort((a, b) => b._totalMilesRaw - a._totalMilesRaw);

		const summaryTotalMiles = rows.reduce((s, r) => s + r._totalMilesRaw, 0);
		const summaryVisitCount = rows.reduce((s, r) => s + r.visits, 0);

		const summaryDisplay = rows.map(({ _totalMilesRaw, ...rest }) => rest);

		return { summaryDisplay, summaryTotalMiles, summaryVisitCount };
	}, [visits, dateRange, searchInput, termsKey]);

	// ── Detailed View ───────────────────────────────────────────────────────────
	// Rows filtered to the selected technician and date
	const { detailDisplay, detailTotalMiles, detailData } = useMemo(() => {
		if (isSummaryView) return { detailDisplay: [], detailTotalMiles: 0, detailData: [] };

		const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;

		let data = (visits ?? [])
			.filter((v) => {
				const names = v.technicianNames
					.split(", ")
					.map((n) => n.trim())
					.filter(Boolean);
				return names.includes(techParam!);
			})
			.map((v) => ({
				id: v.visitId,
				client: v.clientName,
				job: v.jobName,
				address: v.jobAddress,
				date: formatDate(v.visitDate),
				miles: `${v.miles.toFixed(1)} mi`,
				_jobId: v.jobId,
				_rawDate: new Date(v.visitDate),
				_rawMiles: v.miles,
			}));

		if (dateRange.option !== "all") {
			data = data.filter((item) => matchesDateRange(item._rawDate, dateRange));
		}

		if (activeTerms.length > 0) {
			data = data.filter((item) =>
				activeTerms.every((term) => {
					const q = term.toLowerCase();
					return (
						item.client.toLowerCase().includes(q) ||
						item.job.toLowerCase().includes(q) ||
						item.address.toLowerCase().includes(q)
					);
				}),
			);
		}

		const detailTotalMiles = data.reduce((s, r) => s + r._rawMiles, 0);

		data.sort((a, b) => b._rawDate.getTime() - a._rawDate.getTime());

		const detailDisplay = data.map(({ _jobId, _rawDate, _rawMiles, ...rest }) => rest);

		return { detailDisplay, detailTotalMiles, detailData: data };
	}, [visits, isSummaryView, techParam, dateRange, searchInput, termsKey]);

	// ── Nav ────────────────────────────────────────────────────────────
	const handleTechClick = (techName: string) => {
		setSearchInput("");
		const next = new URLSearchParams(location.search);
		next.delete("search"); // clear visit-level search when drilling down
		next.set("tech", encodeURIComponent(techName));
		navigate(`/dispatch/mileage?${next.toString()}`);
	};

	const handleBackToSummary = () => {
		setSearchInput("");
		const next = new URLSearchParams(location.search);
		next.delete("tech");
		next.delete("search");
		const qs = next.toString();
		navigate(`/dispatch/mileage${qs ? `?${qs}` : ""}`);
	};

	const clearAllFilters = () => {
		setSearchInput("");
		const next = new URLSearchParams(location.search);
		next.delete("search");
		next.delete("date");
		next.delete("dateFrom");
		next.delete("dateTo");
		navigate(`/dispatch/mileage${techParam ? `?tech=${encodeURIComponent(techParam)}` : ""}`);
	};

	const hasActiveFilters =
		terms.length > 0 || (dateParamKey !== null && dateParamKey !== "all");

	const exportRows = isSummaryView ? summaryDisplay : detailDisplay;
	const exportColumns = useMemo(
		() =>
			(exportRows[0] ? Object.keys(exportRows[0]) : [])
				.filter((key) => key !== "id")
				.map((key) => ({ key, label: camelCaseToRegular(key) })),
		[exportRows],
	);

	return (
		<div className="text-text-primary">
			<PageHeader
				title={isSummaryView ? "Mileage Report" : techParam ?? "Mileage"}
				subtitle={
					!isSummaryView ? (
						<button
							onClick={handleBackToSummary}
							className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors mt-0.5"
						>
							<ArrowLeft size={14} />
							All Technicians
						</button>
					) : undefined
				}
			/>

			{/* Summary Cards */}
			<div className="grid grid-cols-3 gap-3 mb-4">
				{isSummaryView ? (
					<>
						<div className="p-4 bg-base border border-border-subtle rounded-lg">
							<p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-1">
								Total Miles
							</p>
							<p className="text-xl font-bold text-primary-text tabular-nums">
								{summaryTotalMiles.toFixed(1)} mi
							</p>
							<p className="text-xs text-text-muted mt-0.5">
								{summaryVisitCount} visit{summaryVisitCount !== 1 ? "s" : ""}
							</p>
						</div>
						<div className="p-4 bg-base border border-border-subtle rounded-lg">
							<p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-1">
								Technicians
							</p>
							<p className="text-xl font-bold text-text-primary tabular-nums">
								{summaryDisplay.length}
							</p>
							<p className="text-xs text-text-muted mt-0.5">with mileage records</p>
						</div>
						<div className="p-4 bg-base border border-border-subtle rounded-lg">
							<p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-1">
								Avg Miles / Visit
							</p>
							<p className="text-xl font-bold text-text-primary tabular-nums">
								{summaryVisitCount > 0
									? (summaryTotalMiles / summaryVisitCount).toFixed(1)
									: "0.0"}{" "}
								mi
							</p>
						</div>
					</>
				) : (
					<>
						<div className="p-4 bg-base border border-border-subtle rounded-lg">
							<p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-1">
								Total Miles
							</p>
							<p className="text-xl font-bold text-primary-text tabular-nums">
								{detailTotalMiles.toFixed(1)} mi
							</p>
						</div>
						<div className="p-4 bg-base border border-border-subtle rounded-lg">
							<p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-1">
								Visits
							</p>
							<p className="text-xl font-bold text-text-primary tabular-nums">
								{detailDisplay.length}
							</p>
						</div>
						<div className="p-4 bg-base border border-border-subtle rounded-lg">
							<p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-1">
								Avg Miles / Visit
							</p>
							<p className="text-xl font-bold text-text-primary tabular-nums">
								{detailDisplay.length > 0
									? (detailTotalMiles / detailDisplay.length).toFixed(1)
									: "0.0"}{" "}
								mi
							</p>
						</div>
					</>
				)}
			</div>

			<PageControls
				className="mb-4"
				left={
					<SearchBar
						key={isSummaryView ? "summary-search" : "detail-search"}
						paramKey="search"
						placeholder={
							isSummaryView
								? "Search by technician..."
								: "Search by client, job, or address..."
						}
						onValueChange={setSearchInput}
						onSubmit={addTerm}
					/>
				}
				middle={<DateRangeFilter paramKey="date" />}
				right={
					<>
						<ExportExcelButton
							onExport={() =>
								exportReport({
									filename: datedFilename("mileage-report"),
									sheetName: "Mileage",
									columns: exportColumns,
									rows: exportRows,
								})
							}
							disabled={exportRows.length === 0}
						/>
						<RefreshReportsButton />
					</>
				}
			/>

			<FilterChips
				filters={[
					...terms.map((term) => ({
						label: `Search: "${term}"`,
						color: "purple" as const,
						onRemove: () => removeTerm(term),
						highlighted: duplicateTerm === term,
					})),
				]}
				resultCount={isSummaryView ? summaryDisplay.length : detailDisplay.length}
				onClearAll={clearAllFilters}
			/>

			<div className="shadow-sm border border-border-subtle p-3 bg-base rounded-lg overflow-x-auto text-left">
				{isSummaryView ? (
					summaryDisplay.length === 0 && !isLoading && !error ? (
						<div className="text-center py-16">
							<Gauge
								size={48}
								className="mx-auto text-text-faint mb-3"
							/>
							<h3 className="text-text-tertiary text-lg font-medium mb-2">
								No mileage records found
							</h3>
							<p className="text-text-muted text-sm">
								{hasActiveFilters
									? "Try adjusting your filters"
									: "Mileage is recorded when technicians click \"I'm Driving\" on a visit"}
							</p>
						</div>
					) : (
						<AdaptableTable
							data={summaryDisplay}
							loadListener={isLoading}
							errListener={error}
							onRowClick={(row) =>
								handleTechClick(row.technician as string)
							}
						/>
					)
				) : detailDisplay.length === 0 && !isLoading && !error ? (
					<div className="text-center py-16">
						<Gauge
							size={48}
							className="mx-auto text-text-faint mb-3"
						/>
						<h3 className="text-text-tertiary text-lg font-medium mb-2">
							No visits found
						</h3>
						<p className="text-text-muted text-sm">
							{hasActiveFilters
								? "Try adjusting your filters"
								: `No mileage visits recorded for ${techParam}`}
						</p>
					</div>
				) : (
					<AdaptableTable
						data={detailDisplay}
						loadListener={isLoading}
						errListener={error}
						onRowClick={(row) => {
							const original = detailData.find((d) => d.id === row.id);
							if (original)
								navigate(
									`/dispatch/jobs/${original._jobId}/visits/${row.id as string}`,
								);
						}}
					/>
				)}
			</div>
		</div>
	);
}
