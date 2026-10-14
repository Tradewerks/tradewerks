import { useMemo, useState } from "react";
import { Clock, ArrowLeft } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import AdaptableTable from "../../components/AdaptableTable";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import PageControls from "../../components/ui/PageControls";
import DateRangeFilter from "../../components/ui/DateRangeFilter";
import PageHeader from "../../components/ui/PageHeader";
import RefreshReportsButton from "../../components/reports/RefreshReportButton";
import ColumnsButton from "../../components/ui/ColumnsButton";
import ExportExcelButton from "../../components/reports/ExportExcelButton";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import { useColumnVisibility, type ColumnOption } from "../../hooks/useColumnVisibility";
import { parseDateRangeFromParams, matchesDateRange } from "../../util/dateRangeUtils";
import { formatDate, formatTime, camelCaseToRegular } from "../../util/util";
import { useTimesheetsReportQuery } from "../../hooks/useReports";
import { exportReport } from "../../api/reports";
import { datedFilename } from "../../util/download";

const fmtHours = (h: number) => h.toFixed(1);


interface StatCard {
	label: string;
	value: string;
	hint?: string;
}


const cols = (...keys: string[]): ColumnOption[] =>
	keys.map((key) => ({ key, label: camelCaseToRegular(key) }));

const SUMMARY_COLS = cols("technician", "shifts", "grossHours", "breakHours", "payableHours");
const DETAIL_COLS = cols("date", "start", "end", "grossHours", "breakHours", "payableHours");

export default function TimesheetsReportPage() {
	const navigate = useNavigate();
	const location = useLocation();
	const { data, isLoading, error } = useTimesheetsReportQuery();

	const [searchInput, setSearchInput] = useState("");
	const { terms, addTerm, removeTerm, duplicateTerm } = useMultiSearch("search");

	const queryParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
	const techRaw = queryParams.get("tech");
	const techParam = techRaw ? decodeURIComponent(techRaw) : null;
	const isSummaryView = techParam === null;

	const dateRange = useMemo(
		() => parseDateRangeFromParams(queryParams, "date"),
		[queryParams],
	);

	const records = useMemo(() => data ?? [], [data]);

	// ── Summary ──────────────────────────────────────────────────────────
	const { summaryRows, summaryStats } = useMemo(() => {
		const dateFiltered = records.filter((r) =>
			dateRange.option === "all" ? true : matchesDateRange(new Date(r.startedAt), dateRange),
		);

		const groups = new Map<string, typeof dateFiltered>();
		for (const r of dateFiltered) {
			const existing = groups.get(r.technicianName);
			if (existing) existing.push(r);
			else groups.set(r.technicianName, [r]);
		}

		const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;
		const surviving = Array.from(groups.entries()).filter(([name]) =>
			activeTerms.every((term) => name.toLowerCase().includes(term.toLowerCase())),
		);

		const built = surviving
			.map(([name, recs]) => {
				const grossHours = recs.reduce((s, r) => s + r.grossHours, 0);
				const breakHours = recs.reduce((s, r) => s + r.breakHours, 0);
				const payableHours = recs.reduce((s, r) => s + r.payableHours, 0);
				return {
					name,
					payableHours,
					row: {
						id: name,
						technician: name,
						shifts: recs.length,
						grossHours: fmtHours(grossHours),
						breakHours: fmtHours(breakHours),
						payableHours: fmtHours(payableHours),
					},
				};
			})
			.sort((a, b) => b.payableHours - a.payableHours);

		const survivingRecords = surviving.flatMap(([, recs]) => recs);
		const payableHours = survivingRecords.reduce((s, r) => s + r.payableHours, 0);
		const shifts = survivingRecords.length;

		return {
			summaryRows: built.map((b) => b.row),
			summaryStats: [
				{
					label: "Total Payable Hours",
					value: fmtHours(payableHours),
					hint: `${shifts} ${shifts === 1 ? "shift" : "shifts"}`,
				},
				{ label: "Technicians", value: String(surviving.length), hint: "with time logged" },
				{
					label: "Avg Payable / Shift",
					value: fmtHours(shifts > 0 ? payableHours / shifts : 0),
				},
			] as StatCard[],
		};
	}, [records, dateRange, searchInput, terms]);

	// ── Detail ───────────────────────────────────────────────────────────
	const { detailRows, detailStats } = useMemo(() => {
		if (isSummaryView) return { detailRows: [], detailStats: [] };

		const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;

		const filtered = records
			.filter((r) => r.technicianName === techParam)
			.filter((r) =>
				dateRange.option === "all" ? true : matchesDateRange(new Date(r.startedAt), dateRange),
			)
			.filter((r) =>
				activeTerms.every((term) =>
					formatDate(r.startedAt).toLowerCase().includes(term.toLowerCase()),
				),
			)
			.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

		const detailRows = filtered.map((r) => ({
			id: r.shiftId,
			date: formatDate(r.startedAt),
			start: formatTime(r.startedAt),
			end: formatTime(r.endedAt),
			grossHours: fmtHours(r.grossHours),
			breakHours: fmtHours(r.breakHours),
			payableHours: fmtHours(r.payableHours),
		}));

		const payableHours = filtered.reduce((s, r) => s + r.payableHours, 0);
		const shifts = filtered.length;

		return {
			detailRows,
			detailStats: [
				{ label: "Total Payable Hours", value: fmtHours(payableHours) },
				{ label: "Shifts", value: String(shifts) },
				{
					label: "Avg Payable / Shift",
					value: fmtHours(shifts > 0 ? payableHours / shifts : 0),
				},
			] as StatCard[],
		};
	}, [records, isSummaryView, techParam, dateRange, searchInput, terms]);

	const columnDefs = isSummaryView ? SUMMARY_COLS : DETAIL_COLS;
	const { hidden, toggle, reset, columnVisibility, visibleColumns } = useColumnVisibility(
		`timesheets:${isSummaryView ? "summary" : "detail"}`,
		columnDefs,
	);


	const handleTechClick = (techName: string) => {
		setSearchInput("");
		const next = new URLSearchParams(location.search);
		next.delete("search"); // clear detail-level search when drilling down
		next.set("tech", encodeURIComponent(techName));
		navigate(`/dispatch/timesheets?${next.toString()}`, { replace: true });
	};

	const handleBackToSummary = () => {
		setSearchInput("");
		const next = new URLSearchParams(location.search);
		next.delete("tech");
		next.delete("search");
		const qs = next.toString();
		navigate(`/dispatch/timesheets${qs ? `?${qs}` : ""}`, { replace: true });
	};

	const clearAllFilters = () => {
		setSearchInput("");
		const next = new URLSearchParams(location.search);
		next.delete("search");
		next.delete("date");
		next.delete("dateFrom");
		next.delete("dateTo");
		navigate(
			`/dispatch/timesheets${techParam ? `?tech=${encodeURIComponent(techParam)}` : ""}`,
			{ replace: true },
		);
	};

	const hasActiveFilters = terms.length > 0 || dateRange.option !== "all";

	const rows = isSummaryView ? summaryRows : detailRows;
	const stats = isSummaryView ? summaryStats : detailStats;
	const showEmpty = rows.length === 0 && !isLoading && !error;

	return (
		<div className="text-text-primary">
			<PageHeader
				title={isSummaryView ? "Timesheets Report" : (techParam ?? "Timesheets")}
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

			<div className="grid grid-cols-3 gap-3 mb-4">
				{stats.map((card) => (
					<div key={card.label} className="p-4 bg-base border border-border-subtle rounded-lg">
						<p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-1">
							{card.label}
						</p>
						<p className="text-xl font-bold text-text-primary tabular-nums">{card.value}</p>
						{"hint" in card && card.hint && (
							<p className="text-xs text-text-muted mt-0.5">{card.hint}</p>
						)}
					</div>
				))}
			</div>

			<PageControls
				className="mb-4"
				left={
					<SearchBar
						key={isSummaryView ? "summary-search" : "detail-search"}
						paramKey="search"
						placeholder={
							isSummaryView ? "Search by technician..." : "Search by date..."
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
									filename: datedFilename("timesheets-report"),
									sheetName: "Timesheets",
									columns: visibleColumns,
									rows,
								})
							}
							disabled={rows.length === 0}
						/>
						<ColumnsButton
							columns={columnDefs}
							hidden={hidden}
							onToggle={toggle}
							onReset={reset}
						/>
						<RefreshReportsButton />
					</>
				}
			/>

			<FilterChips
				filters={terms.map((term) => ({
					label: `Search: "${term}"`,
					color: "purple" as const,
					onRemove: () => removeTerm(term),
					highlighted: duplicateTerm === term,
				}))}
				resultCount={rows.length}
				onClearAll={clearAllFilters}
			/>

			<div className="shadow-sm border border-border-subtle p-3 bg-base rounded-lg overflow-x-auto text-left">
				{showEmpty ? (
					<div className="text-center py-16">
						<Clock size={48} className="mx-auto text-text-faint mb-3" />
						<h3 className="text-text-tertiary text-lg font-medium mb-2">
							No shifts found
						</h3>
						<p className="text-text-muted text-sm">
							{hasActiveFilters
								? "Try adjusting your filters"
								: isSummaryView
									? "Time is recorded when technicians start and end a shift"
									: `No completed shifts recorded for ${techParam}`}
						</p>
					</div>
				) : (
					<AdaptableTable
						data={rows}
						loadListener={isLoading}
						errListener={error}
						columnVisibility={columnVisibility}
						onRowClick={
							isSummaryView
								? (row) => handleTechClick(row.id as string)
								: undefined
						}
					/>
				)}
			</div>
		</div>
	);
}
