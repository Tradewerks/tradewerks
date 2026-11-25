import AdaptableTable from "../../components/AdaptableTable";
import { useInvoicesSummaryQuery } from "../../hooks/useInvoices";
import { getInvoicesPage } from "../../api/invoices";
import { usePagedList } from "../../hooks/usePagedList";
import { useListPaging, dateRangeToParams } from "../../hooks/useListPaging";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { qk } from "../../lib/queryKeys";
import ReportPagination from "../../components/reports/ReportPagination";
import type { ListParams, SortDir } from "../../types/paging";
import { useClientByIdQuery } from "../../hooks/useClients";
import { InvoiceStatusValues, InvoiceStatusColors, InvoiceStatusLabels, type InvoiceStatus, isOverdue } from "../../types/invoices";
import { useState, useMemo, useEffect, useRef } from "react";
import { Plus, MoreVertical, FileText, Upload, AlertCircle, CloudOff } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { formatDate, formatCurrency } from "../../util/util";
import CreateInvoice from "../../components/invoices/CreateInvoice";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import { useDateRangeChip } from "../../hooks/useDateRangeChip";
import PageControls from "../../components/ui/PageControls";
import StatusFilter from "../../components/ui/StatusFilter";
import DateRangeFilter from "../../components/ui/DateRangeFilter";
import SortControl from "../../components/ui/SortControl";
import { parseDateRangeFromParams } from "../../util/dateRangeUtils";
import PageHeader from "../../components/ui/PageHeader";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import { usePermission } from "../../hooks/usePermission";
import { useQBStatusQuery } from "../../hooks/useQuickbooks";
import PageReportButton from "../../components/reports/PageReportButton";
import PageReportKpis from "../../components/reports/PageReportKpis";
import { usePageReport } from "../../components/reports/usePageReport";
import { isCurrentQbRealm } from "../../lib/qbRealm";

const invoiceStatusOptions = InvoiceStatusValues.map((s) => ({
	value: s,
	label: InvoiceStatusLabels[s],
}));

const sortLabels: Record<string, string> = {
	status: "Status",
	issued: "Created Date",
	date: "Due Date",
	client: "Client",
	invoiceNumber: "Invoice #",
	subject: "Subject",
	total: "Total",
	balance: "Balance",
};

// The page's sort keys to the server's sortable columns. A key not listed here
// (an old bookmark) is dropped from the chip and header, not sent to be refused.
const SERVER_SORT: Record<string, string> = {
	status: "status",
	issued: "issue_date",
	date: "due_date",
	client: "client",
	invoiceNumber: "invoice_number",
	subject: "memo",
	total: "total",
	balance: "balance_due",
};

// "dueDate" is the displayed column; the existing "date" sort key already
// drives it (shared with the SortControl "Due Date" option).
const COLUMN_SORT_KEY: Record<string, string> = {
	dueDate: "date",
};

const qbMarkerLabel = (diverged: boolean) =>
	diverged
		? "QuickBooks doesn't match — open the invoice"
		: "Not in QuickBooks — retry from the invoice";

export default function InvoicesPage() {
	const navigate = useNavigate();
	const location = useLocation();
	const [searchInput, setSearchInput] = useState("");
	const [showActionsMenu, setShowActionsMenu] = useState(false);
	const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	const { terms, addTerm, removeTerm, duplicateTerm } = useMultiSearch("search");
	const { removeTerm: removeStatus } = useMultiSearch("status");
	const dateChip = useDateRangeChip("date");

	const queryParams = new URLSearchParams(location.search);
	const clientFilter = queryParams.get("client");
	// Repeated (?status=A&status=B, what the filter writes) or comma-joined.
	const statusFilter = queryParams
		.getAll("status")
		.flatMap((v) => v.split(",").map((x) => x.trim()).filter(Boolean));
	const statusKey = statusFilter.join(",");
	const dateParamKey = queryParams.get("date");
	const dateParamFrom = queryParams.get("dateFrom");
	const dateParamTo = queryParams.get("dateTo");
	const rawSort = queryParams.get("sort");
	const sortParam = rawSort && SERVER_SORT[rawSort] ? rawSort : null;
	const dirParam = queryParams.get("dir");
	const taxMismatchOnly = queryParams.get("qb") === "tax_mismatch";
	const attentionOnly = queryParams.get("qb") === "attention";

	//permissions
	const CREATE_INVOICE = usePermission("create_invoices");
	const report = usePageReport("invoices", "Invoices report");

	const { data: summary, isError: summaryError } = useInvoicesSummaryQuery();
	// Until the totals arrive (or if they fail) the cards say so instead of showing a false zero.
	const money = (n: number | undefined) => (n === undefined ? "—" : formatCurrency(n));
	const countText = (n: number | undefined) =>
		n === undefined ? (summaryError ? "Couldn't load" : "—") : `${n} invoices`;
	const { data: filterClient } = useClientByIdQuery(clientFilter ?? "");
	const { data: qbStatus } = useQBStatusQuery();

	// Open create modal if navigated to /new (legacy link compat)
	useEffect(() => {
		if (location.pathname.endsWith("/new")) {
			setIsCreateModalOpen(true);
			navigate("/dispatch/invoices", { replace: true });
		}
	}, [location.pathname, navigate]);

	useEffect(() => {
		const handleOutsideClick = (event: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
				setShowActionsMenu(false);
			}
		};
		if (showActionsMenu) {
			document.addEventListener("mousedown", handleOutsideClick);
			return () => document.removeEventListener("mousedown", handleOutsideClick);
		}
	}, [showActionsMenu]);

	const taxMismatchCount = summary?.qbTaxMismatchCount ?? 0;
	const attentionCount = summary?.qbAttentionCount ?? 0;

	// Chips and the text being typed go to the server as one string it splits into words.
	const q = useDebouncedValue([...terms, searchInput.trim()].filter(Boolean).join(" "));

	const filters = useMemo(() => {
		const dp = new URLSearchParams();
		if (dateParamKey) dp.set("date", dateParamKey);
		if (dateParamFrom) dp.set("dateFrom", dateParamFrom);
		if (dateParamTo) dp.set("dateTo", dateParamTo);
		const range = dateRangeToParams(parseDateRangeFromParams(dp, "date"));
		const sort = sortParam ? SERVER_SORT[sortParam] : undefined;
		return {
			sort,
			dir: sort ? ((dirParam === "asc" ? "asc" : "desc") as SortDir) : undefined,
			q: q || undefined,
			status: statusFilter.length ? statusFilter : undefined,
			...range,
			client_id: clientFilter ?? undefined,
			qb: (taxMismatchOnly ? "tax_mismatch" : attentionOnly ? "attention" : undefined) as "tax_mismatch" | "attention" | undefined,
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [q, statusKey, clientFilter, sortParam, dirParam, dateParamKey, dateParamFrom, dateParamTo, taxMismatchOnly, attentionOnly]);

	const { page, limit, paginationProps } = useListPaging(filters);
	const { client_id, qb, ...listFilters } = filters;
	const params: ListParams = { page, limit, ...listFilters };
	const {
		data,
		isLoading,
		isFetching,
		error,
	} = usePagedList(
		[...qk.invoices.list(), { client_id, qb }],
		(p) => getInvoicesPage(p, { client_id, qb }),
		params
	);
	const total = data?.total ?? 0;

	const display = useMemo(
		() =>
			(data?.rows ?? []).map((inv) => {
				const overdue = isOverdue(inv);
				const clientName = inv.client?.name || "Unknown Client";

				const subject = inv.memo
					? inv.memo.length > 60
						? inv.memo.slice(0, 57) + "…"
						: inv.memo
					: "—";

				let dueDateDisplay = "No due date";
				if (inv.due_date) {
					dueDateDisplay = formatDate(inv.due_date);
					if (overdue) dueDateDisplay = `⚠ ${dueDateDisplay}`;
				}

				const balanceDue = Number(inv.balance_due ?? 0);
				const total = Number(inv.total ?? 0);

				return {
					id: inv.id,
					client: clientName,
					invoiceNumber: inv.invoice_number,
					dueDate: dueDateDisplay,
					subject,
					status: InvoiceStatusLabels[inv.status as InvoiceStatus] ?? inv.status,
					total: formatCurrency(total),
					balance: balanceDue > 0 ? formatCurrency(balanceDue) : "—",
					_rawStatus: inv.status,
					_isOverdue: overdue,
					_qbTaxMismatch:
						inv.qb_sync_status === "tax_mismatch" &&
						isCurrentQbRealm(inv.account_id, qbStatus),
					_qbDiverged:
						!!inv.qb_diverged_at && isCurrentQbRealm(inv.account_id, qbStatus),
					_qbFailed:
						inv.qb_sync_status === "failed" && isCurrentQbRealm(inv.account_id, qbStatus),
				};
			}),
		[data, qbStatus]
	);

	const removeClientFilter = () => {
		const newParams = new URLSearchParams(location.search);
		newParams.delete("client");
		navigate(`/dispatch/invoices${newParams.toString() ? `?${newParams.toString()}` : ""}`);
	};

	const clearAllFilters = () => {
		setSearchInput("");
		const next = new URLSearchParams(location.search);
		next.delete("search");
		next.delete("client");
		next.delete("status");
		next.delete("date");
		next.delete("dateFrom");
		next.delete("dateTo");
		next.delete("qb");
		navigate(`/dispatch/invoices${next.toString() ? `?${next.toString()}` : ""}`);
	};

	const setTaxMismatchOnly = (on: boolean) => {
		const next = new URLSearchParams(location.search);
		if (on) next.set("qb", "tax_mismatch");
		else next.delete("qb");
		navigate(`/dispatch/invoices${next.toString() ? `?${next.toString()}` : ""}`);
	};

	const setAttentionOnly = (on: boolean) => {
		const next = new URLSearchParams(location.search);
		if (on) next.set("qb", "attention");
		else next.delete("qb");
		navigate(`/dispatch/invoices${next.toString() ? `?${next.toString()}` : ""}`);
	};

	const clearSort = () => {
		const next = new URLSearchParams(location.search);
		next.delete("sort");
		next.delete("dir");
		navigate(`/dispatch/invoices${next.toString() ? `?${next.toString()}` : ""}`);
	};

	const handleSortChange = (col: string) => {
		const key = COLUMN_SORT_KEY[col] ?? col;
		const next = new URLSearchParams(location.search);
		if (next.get("sort") === key) {
			next.set("dir", next.get("dir") === "asc" ? "desc" : "asc");
		} else {
			next.set("sort", key);
			next.set("dir", "asc");
		}
		navigate(`/dispatch/invoices?${next.toString()}`);
	};

	const hasActiveFilters = taxMismatchOnly || attentionOnly || clientFilter || terms.length > 0 || statusFilter.length > 0 || (dateParamKey && dateParamKey !== "all");

	return (
		<div className="text-text-primary">
			{/* Create Invoice Modal */}
			<CreateInvoice
				isModalOpen={isCreateModalOpen}
				setIsModalOpen={setIsCreateModalOpen}
			/>

			<PageHeader title="Invoices" subtitle={<PageReportKpis report={report} />}>
				<PageReportButton report={report} />
				<button
					title={!CREATE_INVOICE ? "You don't have permission to perform this action" : ""}
					disabled={!CREATE_INVOICE}
					className="flex items-center gap-2 px-4 py-2 bg-primary-hover hover:enabled:bg-primary-active rounded-md text-sm font-medium text-on-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
					onClick={() => {
						if (!CREATE_INVOICE) return;
						setIsCreateModalOpen(true);
					}}
				>
					<Plus size={16} />
					New Invoice
				</button>
				<div className="relative" ref={menuRef}>
					<button
						onClick={() => setShowActionsMenu(!showActionsMenu)}
						aria-label="More actions"
						aria-expanded={showActionsMenu}
						aria-haspopup="menu"
						className="flex items-center justify-center p-2.5 hover:bg-surface rounded-md transition-colors border border-border hover:border-border-strong"
					>
						<MoreVertical size={20} className="text-text-primary" />
					</button>
					{showActionsMenu && (
						<div className="absolute right-0 mt-2 w-56 bg-canvas border border-border-strong rounded-lg shadow-2xl shadow-black/50 z-50">
							<div className="py-1">
								<div className="px-4 py-2 text-xs text-text-muted italic border-b border-border-subtle mb-1">
									Options yet to be
									implemented
								</div>
								<button
									onClick={() =>
										setShowActionsMenu(
											false
										)
									}
									className="w-full px-4 py-2 text-left text-sm hover:bg-surface/70 transition-colors flex items-center gap-2"
								>
									<Upload size={16} />
									Import Invoices
								</button>
							</div>
						</div>
					)}
				</div>
			</PageHeader>


			{/* Summary Cards */}
			<div className="grid grid-cols-3 gap-3 mb-4">
				<div className="p-4 bg-base border border-border-subtle rounded-lg">
					<p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-1">
						Outstanding
					</p>
					<p className="text-xl font-bold text-primary-text tabular-nums">
						{money(summary?.outstanding.amount)}
					</p>
					<p className="text-xs text-text-muted mt-0.5">
						{countText(summary?.outstanding.count)}
					</p>
				</div>
				<div className="p-4 bg-base border border-error-border rounded-lg">
					<p className="text-xs text-error-text/70 uppercase tracking-wide font-semibold mb-1">
						Overdue
					</p>
					<p className="text-xl font-bold text-error-text tabular-nums">
						{money(summary?.overdue.amount)}
					</p>
					<p className="text-xs text-text-muted mt-0.5">
						{countText(summary?.overdue.count)}
					</p>
				</div>
				<div className="p-4 bg-base border border-border-subtle rounded-lg">
					<p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-1">
						Paid (All Time)
					</p>
					<p className="text-xl font-bold text-success-text tabular-nums">
						{money(summary?.paid.amount)}
					</p>
					<p className="text-xs text-text-muted mt-0.5">
						{countText(summary?.paid.count)}
					</p>
				</div>
			</div>

			{/* Pushes that QuickBooks re-taxed are otherwise only visible one
			    invoice at a time. */}
			{taxMismatchCount > 0 && !taxMismatchOnly && (
				<div
					role="status"
					className="mb-3 flex items-center gap-2 rounded-lg border border-warning-border bg-warning-bg px-4 py-2.5 text-sm text-warning-text"
				>
					<AlertCircle size={16} className="flex-shrink-0" />
					<span className="flex-1">
						{taxMismatchCount === 1
							? "1 invoice has"
							: `${taxMismatchCount} invoices have`}{" "}
						a different tax amount in QuickBooks and can't be sent from there.
					</span>
					<button
						type="button"
						onClick={() => setTaxMismatchOnly(true)}
						className="font-medium underline underline-offset-2 hover:text-text-primary"
					>
						Show {taxMismatchCount === 1 ? "it" : "them"}
					</button>
				</div>
			)}

			{attentionCount > 0 && !attentionOnly && !taxMismatchOnly && (
				<button
					type="button"
					onClick={() => setAttentionOnly(true)}
					className="mb-3 inline-flex items-center gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-1.5 text-sm font-medium text-warning-text transition-colors hover:text-text-primary"
				>
					<CloudOff size={14} className="flex-shrink-0" />
					QuickBooks: needs attention ({attentionCount})
				</button>
			)}

				<PageControls
				className="mb-3"
				left={
					<SearchBar
						paramKey="search"
						placeholder="Search invoices..."
						onValueChange={setSearchInput}
						onSubmit={addTerm}
					/>
				}
				middle={
					<div className="flex items-center gap-2">
						<StatusFilter
							paramKey="status"
							placeholder="Status"
							options={invoiceStatusOptions}
						/>
						<DateRangeFilter paramKey="date" />
						<SortControl
							options={[
								{ value: "status", label: "Status" },
								{ value: "issued", label: "Created Date" },
								{ value: "date", label: "Due Date" },
								{ value: "client", label: "Client" },
								{ value: "invoiceNumber", label: "Invoice #" },
								{ value: "subject", label: "Subject" },
								{ value: "total", label: "Total" },
								{ value: "balance", label: "Balance" },
							]}
							defaultDirByField={{ status: "asc", issued: "desc", date: "desc", total: "desc", balance: "desc" }}
						/>
					</div>
				}
				right={null}
			/>

			{/* Filter Bar */}
			<FilterChips
				filters={[
					taxMismatchOnly
						? {
								label: "QuickBooks tax differs",
								color: "orange" as const,
								onRemove: () => setTaxMismatchOnly(false),
							}
						: null,
					attentionOnly
						? {
								label: "QuickBooks: needs attention",
								color: "orange" as const,
								onRemove: () => setAttentionOnly(false),
							}
						: null,
					clientFilter && filterClient
						? { label: `Client: ${filterClient.name}`, color: "blue" as const, onRemove: removeClientFilter }
						: null,
					...statusFilter.map((s) => ({
						label: `Status: ${InvoiceStatusLabels[s as InvoiceStatus] ?? s}`,
						color: "green" as const,
						classes: InvoiceStatusColors[s as InvoiceStatus],
						onRemove: () => removeStatus(s),
					})),
					...terms.map((term) => ({
						label: `Search: "${term}"`,
						color: "purple" as const,
						onRemove: () => removeTerm(term),
						highlighted: duplicateTerm === term,
					})),
					dateChip,
					sortParam
						? {
								label: `Sort: ${sortLabels[sortParam] ?? sortParam} (${dirParam === "asc" ? "asc" : "desc"})`,
								color: "cyan" as const,
								onRemove: clearSort,
							}
						: null,
				]}
				resultCount={total}
				onClearAll={clearAllFilters}
			/>

			{/* Table */}
			<div className="shadow-sm border border-border-subtle p-3 bg-base rounded-lg overflow-hidden text-left">
				{total === 0 && !isLoading && !error ? (
					<div className="text-center py-16">
						<FileText
							size={48}
							className="mx-auto text-text-faint mb-3"
						/>
						<h3 className="text-text-tertiary text-lg font-medium mb-2">
							No invoices found
						</h3>
						<p className="text-text-muted text-sm mb-4">
							{hasActiveFilters
								? "Try adjusting your filters"
								: "Create your first invoice to get started"}
						</p>
						{!hasActiveFilters && (
							<button
								title={!CREATE_INVOICE ? "You don't have permission to perform this action" : ""}
								disabled={!CREATE_INVOICE}
								onClick={() => {
									if (!CREATE_INVOICE) return;
									setIsCreateModalOpen(true);
								}}
								className="inline-flex items-center gap-2 px-4 py-2 bg-primary-hover hover:enabled:bg-primary-active rounded-md text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
							>
								<Plus size={16} />
								New Invoice
							</button>
						)}
					</div>
				) : (
					<AdaptableTable
						data={display}
						loadListener={isLoading}
						errListener={error}
						onRowClick={(row) =>
							navigate(`/dispatch/invoices/${row.id}`)
						}
						columnAlign={{ total: "right", balance: "right" }}
						cellRenderers={{
							status: (row) => {
								const colors =
									InvoiceStatusColors[row._rawStatus as InvoiceStatus];
								return (
									<div className="flex items-center gap-1.5">
										<div
											className={`w-fit px-2 py-1 rounded-full border text-sm font-medium text-nowrap ${colors}`}
										>
											{row.status as string}
										</div>
										{(row._qbFailed === true || row._qbDiverged === true) && (
											<span
												title={qbMarkerLabel(row._qbDiverged === true)}
												className="flex-shrink-0 text-warning-text"
											>
												<CloudOff
													size={14}
													aria-label={qbMarkerLabel(row._qbDiverged === true)}
												/>
											</span>
										)}
										{row._qbTaxMismatch === true && (
											<span title="QuickBooks tax differs" className="flex-shrink-0 text-warning-text">
												<AlertCircle size={15} aria-label="QuickBooks tax differs" />
											</span>
										)}
									</div>
								);
							},
							dueDate: (row) => (
								<span
									className={`text-nowrap ${row._isOverdue ? "text-error-text font-medium" : ""}`}
								>
									{row.dueDate as string}
								</span>
							),
						}}
						sortableColumns={{
							status: true,
							dueDate: true,
							client: true,
							invoiceNumber: true,
							subject: true,
							total: true,
							balance: true,
						}}
						sortKey={sortParam === "date" ? "dueDate" : (sortParam ?? "")}
						sortDir={dirParam === "asc" ? "asc" : "desc"}
						onSortChange={handleSortChange}
					/>
				)}
				<ReportPagination {...paginationProps(total, isFetching)} />
			</div>
		</div>
	);
}
