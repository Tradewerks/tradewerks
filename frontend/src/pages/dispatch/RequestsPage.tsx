import AdaptableTable from "../../components/AdaptableTable";
import { useCreateRequestMutation } from "../../hooks/useRequests";
import { getRequestsPage } from "../../api/requests";
import { usePagedList } from "../../hooks/usePagedList";
import { useListPaging, dateRangeToParams } from "../../hooks/useListPaging";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { qk } from "../../lib/queryKeys";
import ReportPagination from "../../components/reports/ReportPagination";
import type { ListParams, SortDir } from "../../types/paging";
import { useClientByIdQuery } from "../../hooks/useClients";
import { RequestStatusValues, RequestStatusLabels, RequestStatusColors, type RequestStatus } from "../../types/requests";
import { PriorityLabels, PriorityValues, PriorityColors, type Priority } from "../../types/common";
import { useState, useMemo } from "react";
import { Plus } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import CreateRequest from "../../components/requests/CreateRequest";
import { formatDate } from "../../util/util";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import { useDateRangeChip } from "../../hooks/useDateRangeChip";
import PageControls from "../../components/ui/PageControls";
import StatusFilter from "../../components/ui/StatusFilter";
import DateRangeFilter from "../../components/ui/DateRangeFilter";
import { parseDateRangeFromParams } from "../../util/dateRangeUtils";
import PageHeader from "../../components/ui/PageHeader";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import { usePermission } from "../../hooks/usePermission";
import PageReportButton from "../../components/reports/PageReportButton";
import PageReportKpis from "../../components/reports/PageReportKpis";
import { usePageReport } from "../../components/reports/usePageReport";
import SortControl from "../../components/ui/SortControl";

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

// The page's sort keys to the server's sortable columns. A key not listed here
// (an old bookmark) is dropped from the chip and header, not sent to be refused.
const SERVER_SORT: Record<string, string> = {
	date: "created_at",
	priority: "priority",
	status: "status",
	client: "client",
	title: "title",
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
	const { mutateAsync: createRequest } = useCreateRequestMutation();
	const [isModalOpen, setIsModalOpen] = useState(false);
	const [searchInput, setSearchInput] = useState("");

	// permissions
	const CREATE_REQUEST = usePermission("create_requests");
	const report = usePageReport("requests", "Requests report");

	const { terms, addTerm, removeTerm, duplicateTerm } = useMultiSearch("search");
	const { removeTerm: removeStatus } = useMultiSearch("status");
	const dateChip = useDateRangeChip("date");
	const { removeTerm: removePriority } = useMultiSearch("priority");

	const queryParams = new URLSearchParams(location.search);
	const clientFilter = queryParams.get("client");
	// Repeated (?status=A&status=B, what the filter writes) or comma-joined.
	const flat = (key: string) =>
		queryParams.getAll(key).flatMap((v) => v.split(",").map((s) => s.trim()).filter(Boolean));
	const statusFilter = flat("status");
	const priorityFilter = flat("priority");
	const rawSort = queryParams.get("sort");
	const sortParam = rawSort && SERVER_SORT[rawSort] ? rawSort : null;
	const dirParam = queryParams.get("dir");
	const dateOption = queryParams.get("date");
	const dateFrom = queryParams.get("dateFrom");
	const dateTo = queryParams.get("dateTo");

	const { data: filterClient } = useClientByIdQuery(clientFilter);

	// Chips and the text being typed go to the server as one string it splits into words.
	const q = useDebouncedValue([...terms, searchInput.trim()].filter(Boolean).join(" "));

	const filters = useMemo(() => {
		const dp = new URLSearchParams();
		if (dateOption) dp.set("date", dateOption);
		if (dateFrom) dp.set("dateFrom", dateFrom);
		if (dateTo) dp.set("dateTo", dateTo);
		const range = dateRangeToParams(parseDateRangeFromParams(dp, "date"));
		const sort = sortParam ? SERVER_SORT[sortParam] : undefined;
		return {
			sort,
			dir: sort ? ((dirParam === "asc" ? "asc" : "desc") as SortDir) : undefined,
			q: q || undefined,
			status: statusFilter.length ? statusFilter : undefined,
			...range,
			priority: priorityFilter.length ? priorityFilter : undefined,
			client_id: clientFilter ?? undefined,
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [q, statusFilter.join(","), priorityFilter.join(","), clientFilter, sortParam, dirParam, dateOption, dateFrom, dateTo]);

	const { page, limit, paginationProps } = useListPaging(filters);
	const { priority, client_id, ...listFilters } = filters;
	const params: ListParams = { page, limit, ...listFilters };
	const {
		data,
		isLoading: isFetchLoading,
		isFetching,
		error: fetchError,
	} = usePagedList(
		[...qk.requests.list(), { priority, client_id }],
		(p) => getRequestsPage(p, { priority, client_id }),
		params
	);
	const total = data?.total ?? 0;

	const display = useMemo(
		() =>
			(data?.rows ?? []).map((r) => ({
				id: r.id,
				client: r.client?.name || "Unknown Client",
				title: r.title,
				property: r.address || "No address",
				priority: PriorityLabels[r.priority] || r.priority,
				created: formatDate(r.created_at),
				status: RequestStatusLabels[r.status] || r.status,
				_rawStatus: r.status,
				_rawPriority: r.priority,
			})),
		[data]
	);

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
			<PageHeader title="Requests" subtitle={<PageReportKpis report={report} />}>
				<PageReportButton report={report} />
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
				<ReportPagination {...paginationProps(total, isFetching)} />
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
