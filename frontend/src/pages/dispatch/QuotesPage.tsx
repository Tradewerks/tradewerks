import AdaptableTable from "../../components/AdaptableTable";
import { useAllQuotesQuery, useCreateQuoteMutation } from "../../hooks/useQuotes";
import { useClientByIdQuery } from "../../hooks/useClients";
import { useRequestByIdQuery } from "../../hooks/useRequests";
import { QuoteStatusValues, QuoteStatusLabels, QuoteStatusColors, type Quote, type QuoteStatus } from "../../types/quotes";
import { useState, useMemo } from "react";
import { Plus } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import CreateQuote from "../../components/quotes/CreateQuote";
import { formatDate, formatCurrency } from "../../util/util";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import PageControls from "../../components/ui/PageControls";
import StatusFilter from "../../components/ui/StatusFilter";
import DateRangeFilter from "../../components/ui/DateRangeFilter";
import { parseDateRangeFromParams, matchesDateRange } from "../../util/dateRangeUtils";
import PageHeader from "../../components/ui/PageHeader";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import { usePermission } from "../../hooks/usePermission";
import PageReportSection from "../../components/reports/PageReportSection"
import SortControl from "../../components/ui/SortControl";
import type { SortDir } from "../../util/sortUtil";
import {
	withDir,
	compareByOrder,
	compareDateNullsLast,
	comparePriority,
	compareString,
	compareNumber
} from "../../util/sortUtil";
import { PriorityLabels, PriorityValues, PriorityColors, type Priority } from "../../types/common";


const quoteStatusOptions = QuoteStatusValues.map((s) => ({
	value: s,
	label: QuoteStatusLabels[s as keyof typeof QuoteStatusLabels] ?? s,
}));

const quotePriorityOptions = PriorityValues.map((s) => ({
	value: s,
	label: PriorityLabels[s as keyof typeof PriorityLabels] ?? s,
}));

const sortLabels: Record<string, string> = {
	priority: "Priority",
	status: "Status",
	date: "Date",
	client: "Client",
	quoteNumber: "Quote #",
	total: "Total",
};

// "created" and "quoteNumber" columns aren't the raw sortable value directly —
// "created" is already driven by "date"; "quoteNumber" sorts on the raw
// `quote_number` field (the column also embeds the title on a second line).
const COLUMN_SORT_KEY: Record<string, string> = {
	created: "date",
};

export default function QuotesPage() {
	const navigate = useNavigate();
	const location = useLocation();
	const { data: quotes, isLoading: isFetchLoading, error: fetchError } = useAllQuotesQuery();
	const { mutateAsync: createQuote } = useCreateQuoteMutation();
	const [isModalOpen, setIsModalOpen] = useState(false);
	const [searchInput, setSearchInput] = useState("");

	const { terms, addTerm, removeTerm, duplicateTerm } = useMultiSearch("search");
	const { removeTerm: removeStatus } = useMultiSearch("status");
	const { removeTerm: removePriority } = useMultiSearch("priority");
	// Collision-free memo key (["ab"] vs ["a","b"] must differ)
	const termsKey = JSON.stringify(terms);

	const queryParams = new URLSearchParams(location.search);
	const clientFilter = queryParams.get("client");
	const requestFilter = queryParams.get("request");
	const statusFilter = queryParams.getAll("status");
	const statusKey = statusFilter.join(",");
	const priorityFilter = queryParams.getAll("priority");
	const priorityKey = priorityFilter.join(",");
	const dateParamKey = queryParams.get("date");
	const dateParamFrom = queryParams.get("dateFrom");
	const dateParamTo = queryParams.get("dateTo");
	const sortParam = queryParams.get("sort");
	const dirParam = queryParams.get("dir");

	// permissions
	const CREATE_QUOTE = usePermission("create_quotes");

	const { data: filterClient } = useClientByIdQuery(clientFilter);
	const { data: filterRequest } = useRequestByIdQuery(requestFilter);

	const display = useMemo(() => {
		const _dp = new URLSearchParams();
		if (dateParamKey) _dp.set("date", dateParamKey);
		if (dateParamFrom) _dp.set("dateFrom", dateParamFrom);
		if (dateParamTo) _dp.set("dateTo", dateParamTo);
		const dateRange = parseDateRangeFromParams(_dp, "date");

		if (!quotes) return [];

		const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;

		let filtered: Quote[] = quotes;

		if (clientFilter) {
			filtered = quotes.filter((q) => q.client_id === clientFilter);
		}

		if (requestFilter) {
			filtered = filtered.filter((q) => q.request_id === requestFilter);
		}

		if (statusFilter.length > 0) {
			filtered = filtered.filter((q) => statusFilter.includes(q.status));
		}

		if (priorityFilter.length > 0) {
			filtered = filtered.filter((q) => priorityFilter.includes(q.priority));
		}

		if (activeTerms.length > 0) {
			filtered = filtered.filter((q) =>
				activeTerms.every((term) => {
					const lower = term.toLowerCase();
					const clientName = q.client?.name?.toLowerCase() || "";
					const title = q.title?.toLowerCase() || "";
					const quoteNumber = q.quote_number?.toLowerCase() || "";
					const status = q.status?.toLowerCase() || "";
					const address = q.address?.toLowerCase() || "";
					const priority = q.priority?.toLowerCase() || "";
					return (
						title.includes(lower) ||
						clientName.includes(lower) ||
						quoteNumber.includes(lower) ||
						status.includes(lower) ||
						address.includes(lower) ||
						priority.includes(lower)
					);
				})
			);
		}

		if (dateRange.option !== "all") {
			filtered = filtered.filter((q) =>
				matchesDateRange(q.created_at ? new Date(q.created_at) : null, dateRange)
			);
		}

		const dir: SortDir = dirParam === "asc" ? "asc" : "desc";
		const comparator: (a: Quote, b: Quote) => number =
			sortParam === "priority"
				? withDir((a, b) => comparePriority(a.priority, b.priority), dir)
				: sortParam === "status"
				? withDir((a, b) => compareByOrder(a.status, b.status, QuoteStatusValues), dir)
				: sortParam === "date"
				? (a, b) => compareDateNullsLast(dir)(a.created_at, b.created_at)
				: sortParam === "client"
				? withDir((a, b) => compareString(a.client?.name, b.client?.name), dir)
				: sortParam === "quoteNumber"
				? withDir((a, b) => compareString(a.quote_number, b.quote_number), dir)
				: sortParam === "total"
				? withDir((a, b) => compareNumber(Number(a.total), Number(b.total)), dir)
				: (a, b) => {
					const statusDiff =
					QuoteStatusValues.indexOf(a.status as QuoteStatus) -
					QuoteStatusValues.indexOf(b.status as QuoteStatus);
				if (statusDiff !== 0) return statusDiff;

				return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
			}
		return filtered
			.slice()
			.sort(comparator)
			.map((q) => ({
				id: q.id,
				client: q.client?.name || "Unknown Client",
				quoteNumber: `${q.quote_number}\n${q.title}`,
				property: q.address || "No address",
				created: formatDate(q.created_at),
				status: QuoteStatusLabels[q.status] || q.status,
				priority: PriorityLabels[q.priority] || q.priority,
				total: formatCurrency(Number(q.total)),
				_rawStatus: q.status,
				_rawPriority: q.priority,
			}));
	}, [quotes, searchInput, termsKey, clientFilter, requestFilter, statusKey, priorityKey, dateParamKey, dateParamFrom, dateParamTo, sortParam, dirParam]);

	const removeFilter = (filterType: "client" | "request") => {
		const newParams = new URLSearchParams(location.search);
		newParams.delete(filterType);
		navigate(`/dispatch/quotes${newParams.toString() ? `?${newParams.toString()}` : ""}`);
	};

	const clearSort = () => {
		const next = new URLSearchParams(location.search);
		next.delete("sort");
		next.delete("dir");
		navigate(`/dispatch/quotes${next.toString() ? `?${next.toString()}` : ""}`);
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
		navigate(`/dispatch/quotes?${next.toString()}`);
	};

	const clearAllFilters = () => {
		setSearchInput("");
		const next = new URLSearchParams(location.search);
		next.delete("search");
		next.delete("client");
		next.delete("request");
		next.delete("status");
		next.delete("priority");
		next.delete("date");
		next.delete("dateFrom");
		next.delete("dateTo");
		next.delete("sort");
		next.delete("dir");
		navigate(`/dispatch/quotes${next.toString() ? `?${next.toString()}` : ""}`);
	};

	return (
		<div className="text-text-primary">
			<PageHeader title="Quotes">
				<button
					title={!CREATE_QUOTE ? "You don't have permission to perform this action" : ""}
					disabled={!CREATE_QUOTE}
					className="flex items-center gap-2 px-4 py-2 bg-primary-hover hover:enabled:bg-primary-active rounded-md text-sm font-medium text-on-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
					onClick={() => {
						if (!CREATE_QUOTE) return;
						setIsModalOpen(true);
					}}
				>
					<Plus size={16} />
					New Quote
				</button>
			</PageHeader>
			<PageReportSection page="quotes" label="Quotes report" />
			<PageControls
				className="mb-3"
				left={
					<SearchBar
						paramKey="search"
						placeholder="Search quotes..."
						onValueChange={setSearchInput}
						onSubmit={addTerm}
					/>
				}
				middle={
					<div className="flex items-center gap-2">
						<StatusFilter paramKey="status" placeholder="Status" options={quoteStatusOptions} />
						<StatusFilter paramKey="priority" placeholder="Priority" options={quotePriorityOptions} />
						<DateRangeFilter paramKey="date" />
						<SortControl
							options={[
								{ value: "priority", label: "Priority" },
								{ value: "status", label: "Status" },
								{ value: "date", label: "Date" },
								{ value: "client", label: "Client" },
								{ value: "quoteNumber", label: "Quote #" },
								{ value: "total", label: "Total" },
							]}
							defaultDirByField={{ priority: "desc", status: "asc", date: "desc", total: "desc" }}
						/>
					</div>
				}
				right={null}
			/>

			<FilterChips
				filters={[
					clientFilter && filterClient
						? { label: `Client: ${filterClient.name}`, color: "blue" as const, onRemove: () => removeFilter("client") }
						: null,
					requestFilter && filterRequest
						? { label: `Request: ${filterRequest.title}`, color: "rose" as const, onRemove: () => removeFilter("request") }
						: null,
					...terms.map((term) => ({
						label: `Search: "${term}"`,
						color: "purple" as const,
						onRemove: () => removeTerm(term),
						highlighted: duplicateTerm === term,
					})),
					...statusFilter.map((status) => ({
						label: `Status: ${QuoteStatusLabels[status as keyof typeof QuoteStatusLabels] ?? status}`,
						color: "green" as const,
						classes: QuoteStatusColors[status as QuoteStatus],
						onRemove: () => removeStatus(status),
					})),
					...priorityFilter.map((pri) => ({
						label: `Priority: ${PriorityLabels[pri as keyof typeof PriorityLabels] ?? pri}`,
						color: "orange" as const,
						classes: PriorityColors[pri as Priority],
						onRemove: () => removePriority(pri),
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

			<div className="shadow-sm border border-border-subtle p-3 bg-base rounded-lg overflow-hidden text-left">
				<style>{`
					table td {
						white-space: pre-line;
					}
				`}</style>
				<AdaptableTable
					data={display}
					loadListener={isFetchLoading}
					errListener={fetchError}
					onRowClick={(row) => navigate(`/dispatch/quotes/${row.id}`)}
					columnAlign={{ total: "right" }}
					cellRenderers={{
						status: (row) => (
							<div
								className={`w-fit px-2 py-1 rounded-full border text-sm font-medium text-nowrap ${QuoteStatusColors[row._rawStatus as QuoteStatus]}`}
							>
								{row.status as string}
							</div>
						),
						priority: (row) => (
							<div
								className={`w-fit px-2 py-1 rounded-md border text-sm font-medium text-nowrap ${PriorityColors[row._rawPriority as Priority]}`}
							>
								{row.priority as string}
							</div>
						),
					}}
					sortableColumns={{
						status: true,
						priority: true,
						client: true,
						quoteNumber: true,
						created: true,
						total: true,
					}}
					sortKey={sortParam === "date" ? "created" : (sortParam ?? "")}
					sortDir={dirParam === "asc" ? "asc" : "desc"}
					onSortChange={handleSortChange}
				/>
			</div>

			<CreateQuote
				isModalOpen={isModalOpen}
				setIsModalOpen={setIsModalOpen}
				createQuote={async (input) => {
					const newQuote = await createQuote(input);

					if (!newQuote?.id)
						throw new Error(
							"Quote creation failed: no ID returned"
						);

					return newQuote.id;
				}}
			/>
		</div>
	);
}
