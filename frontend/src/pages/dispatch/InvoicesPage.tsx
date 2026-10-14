import AdaptableTable from "../../components/AdaptableTable";
import { useAllInvoicesQuery } from "../../hooks/useInvoices";
import { useClientByIdQuery } from "../../hooks/useClients";
import { InvoiceStatusValues, InvoiceStatusColors, InvoiceStatusLabels, type InvoiceStatus, isOverdue } from "../../types/invoices";
import { useState, useMemo, useEffect, useRef } from "react";
import { Plus, MoreVertical, FileText, Upload } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { formatDate, formatCurrency } from "../../util/util";
import CreateInvoice from "../../components/invoices/CreateInvoice";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import PageControls from "../../components/ui/PageControls";
import StatusFilter from "../../components/ui/StatusFilter";
import DateRangeFilter from "../../components/ui/DateRangeFilter";
import SortControl from "../../components/ui/SortControl";
import { parseDateRangeFromParams, matchesDateRange } from "../../util/dateRangeUtils";
import PageHeader from "../../components/ui/PageHeader";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import { usePermission } from "../../hooks/usePermission";
import PageReportSection from "../../components/reports/PageReportSection";
import type { SortDir } from "../../util/sortUtil";
import { withDir, compareByOrder, compareDateNullsLast, compareString, compareNumber } from "../../util/sortUtil";

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

// "dueDate" is the displayed column; the existing "date" sort key already
// drives it (shared with the SortControl "Due Date" option).
const COLUMN_SORT_KEY: Record<string, string> = {
	dueDate: "date",
};

export default function InvoicesPage() {
	const navigate = useNavigate();
	const location = useLocation();
	const { data: invoices, isLoading, error } = useAllInvoicesQuery();

	const [searchInput, setSearchInput] = useState("");
	const [showActionsMenu, setShowActionsMenu] = useState(false);
	const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	const { terms, addTerm, removeTerm, duplicateTerm } = useMultiSearch("search");
	const { removeTerm: removeStatus } = useMultiSearch("status");
	// Collision-free memo key (["ab"] vs ["a","b"] must differ)
	const termsKey = JSON.stringify(terms);

	const queryParams = new URLSearchParams(location.search);
	const clientFilter = queryParams.get("client");
	const statusFilter = queryParams.getAll("status");
	const statusKey = statusFilter.join(",");
	const dateParamKey = queryParams.get("date");
	const dateParamFrom = queryParams.get("dateFrom");
	const dateParamTo = queryParams.get("dateTo");
	const sortParam = queryParams.get("sort");
	const dirParam = queryParams.get("dir");

	//permissions
	const CREATE_INVOICE = usePermission("create_invoices");

	const { data: filterClient } = useClientByIdQuery(clientFilter ?? "");

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

	const overdueCount = useMemo(() => {
		if (!invoices) return 0;
		return invoices.filter(isOverdue).length;
	}, [invoices]);

	const display = useMemo(() => {
		const _dp = new URLSearchParams();
		if (dateParamKey) _dp.set("date", dateParamKey);
		if (dateParamFrom) _dp.set("dateFrom", dateParamFrom);
		if (dateParamTo) _dp.set("dateTo", dateParamTo);
		const dateRange = parseDateRangeFromParams(_dp, "date");

		const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;

		let data =
			invoices?.map((inv) => {
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
					_rawTotal: total,
					_rawBalance: balanceDue,
					_rawDueDate: inv.due_date ? new Date(inv.due_date) : null,
					_isOverdue: overdue,
					_clientId: inv.client_id,
					_issueDate: inv.issue_date
						? new Date(inv.issue_date)
						: null,
				};
			}) ?? [];

		if (clientFilter) data = data.filter((item) => item._clientId === clientFilter);
		if (statusFilter.length > 0) data = data.filter((item) => statusFilter.includes(item._rawStatus));
		if (dateRange.option !== "all")
			data = data.filter((item) => matchesDateRange(item._issueDate, dateRange));
		if (activeTerms.length > 0) {
			data = data.filter((item) =>
				activeTerms.every((term) => {
					const q = term.toLowerCase();
					return (
						item.client.toLowerCase().includes(q) ||
						item.invoiceNumber.toLowerCase().includes(q) ||
						item.subject.toLowerCase().includes(q) ||
						item.status.toLowerCase().includes(q)
					);
				})
			);
		}

		type InvoiceRow = (typeof data)[number];
		const dir: SortDir = dirParam === "asc" ? "asc" : "desc";
		const comparator: (a: InvoiceRow, b: InvoiceRow) => number =
			sortParam === "status"
				? withDir((a, b) => compareByOrder(a._rawStatus, b._rawStatus, InvoiceStatusValues), dir)
				: sortParam === "issued"
				? (a, b) => compareDateNullsLast(dir)(a._issueDate, b._issueDate)
				: sortParam === "date"
				? (a, b) => compareDateNullsLast(dir)(a._rawDueDate, b._rawDueDate)
				: sortParam === "client"
				? withDir((a, b) => compareString(a.client, b.client), dir)
				: sortParam === "invoiceNumber"
				? withDir((a, b) => compareString(a.invoiceNumber, b.invoiceNumber), dir)
				: sortParam === "subject"
				? withDir((a, b) => compareString(a.subject, b.subject), dir)
				: sortParam === "total"
				? withDir((a, b) => compareNumber(a._rawTotal, b._rawTotal), dir)
				: sortParam === "balance"
				? withDir((a, b) => compareNumber(a._rawBalance, b._rawBalance), dir)
				: (a, b) => {
					// default: status, then schedule date (nulls last)
					if (a._isOverdue && !b._isOverdue) return -1;
					if (!a._isOverdue && b._isOverdue) return 1;
					const statusDiff =
						InvoiceStatusValues.indexOf(
							a._rawStatus as InvoiceStatus
						) -
						InvoiceStatusValues.indexOf(
							b._rawStatus as InvoiceStatus
						);
					if (statusDiff !== 0) return statusDiff;
					if (a._rawDueDate && b._rawDueDate)
						return (
							a._rawDueDate.getTime() -
							b._rawDueDate.getTime()
						);
					if (a._rawDueDate) return -1;
					if (b._rawDueDate) return 1;
					return (
						(b._issueDate?.getTime() ?? 0) -
						(a._issueDate?.getTime() ?? 0)
					);
				};

		return (
			data
				.sort(comparator)
		);
	}, [invoices, searchInput, termsKey, clientFilter, statusKey, dateParamKey, dateParamFrom, dateParamTo, sortParam, dirParam]);

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

	const totals = useMemo(() => {
		if (!invoices) return { outstanding: 0, overdue: 0, paid: 0 };
		return invoices.reduce(
			(acc, inv) => {
				const balance = Number(inv.balance_due ?? 0);
				const total = Number(inv.total ?? 0);
				if (inv.status === "Paid") acc.paid += total;
				else if (isOverdue(inv)) acc.overdue += balance;
				else acc.outstanding += balance;
				return acc;
			},
			{ outstanding: 0, overdue: 0, paid: 0 }
		);
	}, [invoices]);

	const hasActiveFilters = clientFilter || terms.length > 0 || statusFilter.length > 0 || (dateParamKey && dateParamKey !== "all");

	return (
		<div className="text-text-primary">
			{/* Create Invoice Modal */}
			<CreateInvoice
				isModalOpen={isCreateModalOpen}
				setIsModalOpen={setIsCreateModalOpen}
			/>

			<PageHeader title="Invoices">
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

			<PageReportSection page="invoices" label="Invoices report" />

			{/* Summary Cards */}
			<div className="grid grid-cols-3 gap-3 mb-4">
				<div className="p-4 bg-base border border-border-subtle rounded-lg">
					<p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-1">
						Outstanding
					</p>
					<p className="text-xl font-bold text-primary-text tabular-nums">
						{formatCurrency(totals.outstanding)}
					</p>
					<p className="text-xs text-text-muted mt-0.5">
						{invoices?.filter(
							(i) =>
								i.status !== "Paid" &&
								i.status !== "Void" &&
								!isOverdue(i)
						).length ?? 0}{" "}
						invoices
					</p>
				</div>
				<div className="p-4 bg-base border border-error-border rounded-lg">
					<p className="text-xs text-error-text/70 uppercase tracking-wide font-semibold mb-1">
						Overdue
					</p>
					<p className="text-xl font-bold text-error-text tabular-nums">
						{formatCurrency(totals.overdue)}
					</p>
					<p className="text-xs text-text-muted mt-0.5">
						{overdueCount} invoices
					</p>
				</div>
				<div className="p-4 bg-base border border-border-subtle rounded-lg">
					<p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-1">
						Paid (All Time)
					</p>
					<p className="text-xl font-bold text-success-text tabular-nums">
						{formatCurrency(totals.paid)}
					</p>
					<p className="text-xs text-text-muted mt-0.5">
						{invoices?.filter((i) => i.status === "Paid")
							.length ?? 0}{" "}
						invoices
					</p>
				</div>
			</div>

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
					sortParam
						? {
								label: `Sort: ${sortLabels[sortParam] ?? sortParam} (${dirParam === "asc" ? "asc" : "desc"})`,
								color: "cyan" as const,
								onRemove: clearSort,
							}
						: null,
				]}
				resultCount={display.length}
				onClearAll={clearAllFilters}
			/>

			{/* Table */}
			<div className="shadow-sm border border-border-subtle p-3 bg-base rounded-lg overflow-hidden text-left">
				{display.length === 0 && !isLoading && !error ? (
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
									<div
										className={`w-fit px-2 py-1 rounded-full border text-sm font-medium text-nowrap ${colors}`}
									>
										{row.status as string}
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
			</div>
		</div>
	);
}
