import AdaptableTable from "../../components/AdaptableTable";
import { useAllRequestsQuery, useCreateRequestMutation } from "../../hooks/useRequests";
import { useClientByIdQuery } from "../../hooks/useClients";
import { RequestStatusValues, RequestStatusLabels, RequestStatusColors, type Request, type RequestStatus } from "../../types/requests";
import { PriorityLabels, PriorityValues, PriorityColors, type Priority } from "../../types/common";
import { useState, useMemo } from "react";
import { Plus } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import CreateRequest from "../../components/requests/CreateRequest";
import { formatDate } from "../../util/util";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import PageControls from "../../components/ui/PageControls";
import StatusFilter from "../../components/ui/StatusFilter";
import DateRangeFilter from "../../components/ui/DateRangeFilter";
import { parseDateRangeFromParams, matchesDateRange } from "../../util/dateRangeUtils";
import PageHeader from "../../components/ui/PageHeader";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import { usePermission } from "../../hooks/usePermission";
import PageReportSection from "../../components/reports/PageReportSection";
import SortControl from "../../components/ui/SortControl";
import type { SortDir } from "../../util/sortUtil";
import {
	withDir,
	compareByOrder,
	compareDateNullsLast,
	comparePriority,
	compareString
} from "../../util/sortUtil";

const requestStatusOptions = RequestStatusValues.map((s) => ({
	value: s,
	label: RequestStatusLabels[s as keyof typeof RequestStatusLabels] ?? s,
}));

const requestPriorityOptions = PriorityValues.map((s) => ({
	value: s,
	label: PriorityLabels[s as keyof typeof PriorityLabels] ?? s,
}));

const sortLabels: Record<string, string> = {
	priority: "Priority",
	status: "Status",
	date: "Date",
	client: "Client",
	title: "Title",
};

// Display column ids whose value isn't the sortable one — "created" shows a
// formatted date but the real value is `created_at` (already driven by the
// existing "date" sort key).
const COLUMN_SORT_KEY: Record<string, string> = {
	created: "date",
};

export default function RequestsPage() {
	const navigate = useNavigate();
	const location = useLocation();
	const {
		data: requests,
		isLoading: isFetchLoading,
		error: fetchError,
	} = useAllRequestsQuery();
	const { mutateAsync: createRequest } = useCreateRequestMutation();
	const [isModalOpen, setIsModalOpen] = useState(false);
	const [searchInput, setSearchInput] = useState("");

	// permissions
	const CREATE_REQUEST = usePermission("create_requests");

	const { terms, addTerm, removeTerm, duplicateTerm } = useMultiSearch("search");
	const { removeTerm: removeStatus } = useMultiSearch("status");
	const { removeTerm: removePriority } = useMultiSearch("priority");
	// Collision-free memo key (["ab"] vs ["a","b"] must differ)
	const termsKey = JSON.stringify(terms);

	const queryParams = new URLSearchParams(location.search);
	const clientFilter = queryParams.get("client");
	const statusFilter = queryParams.getAll("status");
	const statusKey = statusFilter.join(",");
	const priorityFilter = queryParams.getAll("priority");
	const priorityKey = priorityFilter.join(",");
	const dateParamKey = queryParams.get("date");
	const dateParamFrom = queryParams.get("dateFrom");
	const dateParamTo = queryParams.get("dateTo");
	const sortParam = queryParams.get("sort");
	const dirParam = queryParams.get("dir");

	const { data: filterClient } = useClientByIdQuery(clientFilter);

	const display = useMemo(() => {
		const _dp = new URLSearchParams();
		if (dateParamKey) _dp.set("date", dateParamKey);
		if (dateParamFrom) _dp.set("dateFrom", dateParamFrom);
		if (dateParamTo) _dp.set("dateTo", dateParamTo);
		const dateRange = parseDateRangeFromParams(_dp, "date");

		if (!requests) return [];

		const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;

		let filtered: Request[] = requests;

		if (clientFilter) {
			filtered = requests.filter((r) => r.client_id === clientFilter);
		}

		if (statusFilter.length > 0) {
			filtered = filtered.filter((r) => statusFilter.includes(r.status));
		}

		if (priorityFilter.length > 0) {
			filtered = filtered.filter((r) => priorityFilter.includes(r.priority));
		}

		if (activeTerms.length > 0) {
			filtered = filtered.filter((r) =>
				activeTerms.every((term) => {
					const lower = term.toLowerCase();
					const clientName = r.client?.name?.toLowerCase() || "";
					const title = r.title?.toLowerCase() || "";
					const status = r.status?.toLowerCase() || "";
					const address = r.address?.toLowerCase() || "";
					const priority = r.priority?.toLowerCase() || "";
					return (
						title.includes(lower) ||
						clientName.includes(lower) ||
						status.includes(lower) ||
						address.includes(lower) ||
						priority.includes(lower)
					);
				})
			);
		}

		if (dateRange.option !== "all") {
			filtered = filtered.filter((r) =>
				matchesDateRange(r.created_at ? new Date(r.created_at) : null, dateRange)
			);
		}

		const dir: SortDir = dirParam === "asc" ? "asc" : "desc";
		const comparator: (a: Request, b: Request) => number =
			sortParam === "priority"
				? withDir((a, b) => comparePriority(a.priority, b.priority), dir)
				: sortParam === "status"
				? withDir((a, b) => compareByOrder(a.status, b.status, RequestStatusValues), dir)
				: sortParam === "date"
				? (a, b) => compareDateNullsLast(dir)(a.created_at, b.created_at)
				: sortParam === "client"
				? withDir((a, b) => compareString(a.client?.name, b.client?.name), dir)
				: sortParam === "title"
				? withDir((a, b) => compareString(a.title, b.title), dir)
				: (a, b) => {
					// default: status, then priority (Emergency first)
					const statusDiff = compareByOrder(a.status, b.status, RequestStatusValues);
					if (statusDiff !== 0) return statusDiff;
					return comparePriority(b.priority, a.priority);
				};

		return filtered
			.slice()
			.sort(comparator)
			.map((r) => ({
				id: r.id,
				client: r.client?.name || "Unknown Client",
				title: r.title,
				property: r.address || "No address",
				priority: PriorityLabels[r.priority] || r.priority,
				created: formatDate(r.created_at),
				status: RequestStatusLabels[r.status] || r.status,
				_rawStatus: r.status,
				_rawPriority: r.priority,
			}));
	}, [requests, searchInput, termsKey, clientFilter, statusKey, dateParamKey, dateParamFrom, dateParamTo, sortParam, dirParam, priorityKey]);

	const removeFilter = (filterType: "client") => {
		const newParams = new URLSearchParams(location.search);
		newParams.delete(filterType);
		navigate(`/dispatch/requests${newParams.toString() ? `?${newParams.toString()}` : ""}`);
	};

	const clearSort = () => {
		const next = new URLSearchParams(location.search);
		next.delete("sort");
		next.delete("dir");
		navigate(`/dispatch/requests${next.toString() ? `?${next.toString()}` : ""}`);
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
		navigate(`/dispatch/requests?${next.toString()}`);
	};

	const clearAllFilters = () => {
		setSearchInput("");
		const next = new URLSearchParams(location.search);
		next.delete("search");
		next.delete("client");
		next.delete("status");
		next.delete("priority");
		next.delete("date");
		next.delete("dateFrom");
		next.delete("dateTo");
		next.delete("sort");
		next.delete("dir");
		navigate(`/dispatch/requests${next.toString() ? `?${next.toString()}` : ""}`);
	};

	return (
		<div className="text-text-primary">
			<PageHeader title="Requests">
				<button
					disabled={!CREATE_REQUEST}
					title={!CREATE_REQUEST ? "You don't have permission to perform this action" : undefined}
					className="flex items-center gap-2 px-4 py-2 bg-primary-hover hover:enabled:bg-primary-active rounded-md text-sm font-medium text-on-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
					onClick={() => {
						if (!CREATE_REQUEST) return;
						setIsModalOpen(true);
					}}
				>
					<Plus size={16} />
					New Request
				</button>
			</PageHeader>

			<PageReportSection page="requests" label="Requests report" />

			<PageControls
				className="mb-3"
				left={
					<SearchBar
						paramKey="search"
						placeholder="Search requests..."
						onValueChange={setSearchInput}
						onSubmit={addTerm}
					/>
				}
				middle={
					<div className="flex items-center gap-2">
						<StatusFilter paramKey="status" placeholder="Status" options={requestStatusOptions} />
						{/* reusing status filter for priority */}
						<StatusFilter paramKey="priority" placeholder="Priority" options={requestPriorityOptions} />
						<DateRangeFilter paramKey="date" />
						<SortControl
							options={[
								{ value: "priority", label: "Priority" },
								{ value: "status", label: "Status" },
								{ value: "date", label: "Date" },
								{ value: "client", label: "Client" },
								{ value: "title", label: "Title" },
							]}
							defaultDirByField={{ priority: "desc", status: "asc", date: "desc" }}
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
					...terms.map((term) => ({
						label: `Search: "${term}"`,
						color: "purple" as const,
						onRemove: () => removeTerm(term),
						highlighted: duplicateTerm === term,
					})),
					...statusFilter.map((status) => ({
						label: `Status: ${RequestStatusLabels[status as keyof typeof RequestStatusLabels] ?? status}`,
						color: "green" as const,
						classes: RequestStatusColors[status as RequestStatus],
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
				<AdaptableTable
					data={display}
					loadListener={isFetchLoading}
					errListener={fetchError}
					onRowClick={(row) =>
						navigate(`/dispatch/requests/${row.id}`)
					}
					cellRenderers={{
						status: (row) => (
							<div
								className={`w-fit px-2 py-1 rounded-full border text-sm font-medium text-nowrap ${RequestStatusColors[row._rawStatus as RequestStatus]}`}
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
						title: true,
						created: true,
					}}
					sortKey={sortParam === "date" ? "created" : (sortParam ?? "")}
					sortDir={dirParam === "asc" ? "asc" : "desc"}
					onSortChange={handleSortChange}
				/>
			</div>

			<CreateRequest
				isModalOpen={isModalOpen}
				setIsModalOpen={setIsModalOpen}
				createRequest={async (input) => {
					const newRequest = await createRequest(input);

					if (!newRequest?.id)
						throw new Error(
							"Request creation failed: no ID returned"
						);

					return newRequest.id;
				}}
			/>
		</div>
	);
}
