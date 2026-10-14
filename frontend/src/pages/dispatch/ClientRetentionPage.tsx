import { useEffect, useMemo, useState } from "react";
import { UserX } from "lucide-react";
import { useNavigate } from "react-router-dom";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import PageControls from "../../components/ui/PageControls";
import PageHeader from "../../components/ui/PageHeader";
import RefreshReportsButton from "../../components/reports/RefreshReportButton";
import ColumnsButton from "../../components/ui/ColumnsButton";
import Dropdown from "../../components/ui/Dropdown";
import ExportExcelButton from "../../components/reports/ExportExcelButton";
import AdaptableTable from "../../components/AdaptableTable";
import ReportPagination from "../../components/reports/ReportPagination";
import { exportReportServer } from "../../api/reports";
import { datedFilename } from "../../util/download";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import {
	buildColumnAlign,
	buildHeaderLabels,
	useColumnVisibility,
	type ColumnOption,
} from "../../hooks/useColumnVisibility";
import { formatCurrency } from "../../util/util";
import { useClientRetentionQuery } from "../../hooks/useReports";
import type { ClientRetentionRow, ReportFetchParams } from "../../types/reports";

const COLS: ColumnOption[] = [
	{ key: "name", label: "Client" },
	{ key: "primaryContact", label: "Primary Contact" },
	{ key: "email", label: "Email" },
	{ key: "phone", label: "Phone" },
	{ key: "lastActivity", label: "Last Activity" },
	{ key: "lifetimeRevenue", label: "Lifetime Revenue" },
	{ key: "jobCount", label: "Jobs" },
];

const NUMERIC_KEYS = ["lifetimeRevenue", "jobCount"] as const;

const HEADER_LABELS = buildHeaderLabels(COLS);
const COLUMN_ALIGN = buildColumnAlign(COLS, NUMERIC_KEYS);

const LOOKBACK_OPTIONS = [
	{ value: "90", label: "No activity in 90 days" },
	{ value: "180", label: "No activity in 180 days" },
	{ value: "365", label: "No activity in 365 days" },
];

export default function ClientRetentionPage() {
	const navigate = useNavigate();
	const [searchInput, setSearchInput] = useState("");
	const { terms, addTerm, removeTerm, clearAll, duplicateTerm } = useMultiSearch("search");

	const [lookbackDays, setLookbackDays] = useState(180);
	const [page, setPage] = useState(0);
	const [pageSize, setPageSize] = useState(50);

	const searchTerms = useMemo(() => {
		const t = searchInput.trim() ? [...terms, searchInput.trim()] : terms;
		return t.length ? t : undefined;
	}, [terms, searchInput]);

	const queryParams = useMemo<ReportFetchParams>(
		() => ({ searchTerms, lookbackDays, page, limit: pageSize }),
		[searchTerms, lookbackDays, page, pageSize],
	);

	const { data, isLoading, isFetching, error } = useClientRetentionQuery(queryParams);
	const rows = useMemo(() => (data?.rows ?? []) as unknown as ClientRetentionRow[], [data]);
	const total = data?.total ?? 0;
	const hasMore = data?.hasMore ?? false;

	const filterKey = JSON.stringify([searchTerms, lookbackDays, pageSize]);
	useEffect(() => {
		setPage(0);
	}, [filterKey]);

	const { hidden, toggle, reset, columnVisibility, visibleColumns } = useColumnVisibility(
		"client-retention",
		COLS,
	);

	const displayRows = useMemo(
		() =>
			rows.map((r) => ({
				id: r.id,
				name: r.name,
				primaryContact: r.primaryContact,
				email: r.email,
				phone: r.phone,
				lastActivity: r.lastActivity,
				lifetimeRevenue: formatCurrency(Number(r.lifetimeRevenue)),
				jobCount: r.jobCount,
			})),
		[rows],
	);

	const clearAllFilters = () => {
		setSearchInput("");
		clearAll();
	};

	const hasActiveFilters = terms.length > 0;
	const showEmpty = total === 0 && !isLoading && !error;

	return (
		<div className="text-text-primary">
			<PageHeader title="Client Retention" />

			<PageControls
				className="mb-4"
				left={
					<SearchBar
						paramKey="search"
						placeholder="Search by client or contact..."
						onValueChange={setSearchInput}
						onSubmit={addTerm}
					/>
				}
				right={
					<>
						<div className="w-52">
							<Dropdown
								aria-label="Retention window"
								value={String(lookbackDays)}
								onChange={(v) => setLookbackDays(Number(v))}
								entries={LOOKBACK_OPTIONS.map((o) => (
									<option key={o.value} value={o.value}>
										{o.label}
									</option>
								))}
							/>
						</div>
						<ExportExcelButton
							onExport={() =>
								exportReportServer({
									report: "client-retention",
									filename: datedFilename("client-retention"),
									sheetName: "Client Retention",
									columns: visibleColumns,
									params: { searchTerms, lookbackDays },
								})
							}
							disabled={total === 0}
						/>
						<ColumnsButton columns={COLS} hidden={hidden} onToggle={toggle} onReset={reset} />
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
				resultCount={total}
				onClearAll={clearAllFilters}
			/>

			<div className="shadow-sm border border-border-subtle p-3 bg-base rounded-lg overflow-x-auto text-left">
				{showEmpty ? (
					<div className="text-center py-16">
						<UserX size={48} className="mx-auto text-text-faint mb-3" />
						<h3 className="text-text-tertiary text-lg font-medium mb-2">
							No lapsed clients
						</h3>
						<p className="text-text-muted text-sm">
							{hasActiveFilters
								? "Try adjusting your filters"
								: "Every active client has had a purchase, service, or contact in this window"}
						</p>
					</div>
				) : (
					<>
						<AdaptableTable
							data={displayRows}
							loadListener={isLoading}
							errListener={error}
							formatNums={false}
							columnVisibility={columnVisibility}
							headerLabels={HEADER_LABELS}
							columnAlign={COLUMN_ALIGN}
							onRowClick={(row) => navigate(`/dispatch/clients/${row.id as string}`)}
						/>
						<ReportPagination
							page={page}
							pageSize={pageSize}
							total={total}
							hasMore={hasMore}
							onPageChange={setPage}
							onPageSizeChange={setPageSize}
							isFetching={isFetching}
						/>
					</>
				)}
			</div>
		</div>
	);
}
