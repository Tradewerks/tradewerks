import AdaptableTable from "../../components/AdaptableTable";
import { useCreateJobMutation } from "../../hooks/useJobs";
import { getJobsPage } from "../../api/jobs";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useListPaging, dateRangeToParams } from "../../hooks/useListPaging";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { qk } from "../../lib/queryKeys";
import ReportPagination from "../../components/reports/ReportPagination";
import type { ListParams, SortDir } from "../../types/paging";
import { useAllRecurringPlansQuery } from "../../hooks/useRecurringPlans";
import { useClientByIdQuery } from "../../hooks/useClients";
import { JobStatusValues, JobStatusColors, type JobStatus } from "../../types/jobs";
import { RecurringPlanStatusValues, RecurringPlanStatusColors, type RecurringPlanStatus } from "../../types/recurringPlans";
import { useState, useMemo, useEffect, useRef } from "react";
import { Plus, MoreVertical, Repeat, Upload } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import CreateJob from "../../components/jobs/CreateJob";
import CreateRecurringPlan from "../../components/recurringPlans/CreateRecurringPlan";
import { addSpacesToCamelCase, formatDate, formatCurrency } from "../../util/util";
import SearchBar from "../../components/ui/SearchBar";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import FilterChips from "../../components/ui/FilterChips";
import { useDateRangeChip } from "../../hooks/useDateRangeChip";
import PageControls from "../../components/ui/PageControls";
import StatusFilter from "../../components/ui/StatusFilter";
import SortControl from "../../components/ui/SortControl";
import DateRangeFilter from "../../components/ui/DateRangeFilter";
import {
	parseDateRangeFromParams,
	overlapsDateRange,
	type DateRangeOption,
} from "../../util/dateRangeUtils";
import ContextToggle, { type JobsView } from "../../components/ui/ContextToggle";
import PageHeader from "../../components/ui/PageHeader";
import { usePermission } from "../../hooks/usePermission";
import PageReportButton from "../../components/reports/PageReportButton";
import PageReportKpis from "../../components/reports/PageReportKpis";
import { usePageReport } from "../../components/reports/usePageReport";
import { PriorityLabels, PriorityValues, PriorityColors, type Priority } from "../../types/common";

const jobStatusOptions = JobStatusValues.map((s) => ({
	value: s,
	label: addSpacesToCamelCase(s),
}));

// Plans are filtered by when they're in effect, so past and future ranges both
// mean something; Tomorrow alone adds nothing over Today/Next 7 days.
const PLAN_DATE_PRESETS: DateRangeOption[] = [
	"all",
	"today",
	"last_7_days",
	"last_30_days",
	"this_month",
	"next_7_days",
	"next_30_days",
	"next_month",
	"custom",
];

const planStatusOptions = RecurringPlanStatusValues.map((s) => ({
	value: s,
	label: addSpacesToCamelCase(s),
}));

const jobPriorityOptions = PriorityValues.map((s) => ({
	value: s,
	label: PriorityLabels[s as keyof typeof PriorityLabels] ?? s,
}));

const sortLabels: Record<string, string> = {
	priority: "Priority",
	status: "Status",
	client: "Client",
	jobNumber: "Job #",
	total: "Total",
};

// The page's sort keys to the server's sortable columns. A key not listed here
// (an old bookmark, or the retired Date sort) is dropped from the chip and header,
// not sent to be refused: the server has no column holding a job's next visit.
const SERVER_SORT: Record<string, string> = {
	priority: "priority",
	status: "status",
	client: "client",
	jobNumber: "job_number",
	total: "total",
};

type JobRow = {
	id: string;
	client: string;
	jobNumber: string;
	property: string;
	schedule: string;
	status: string;
	priority: Priority;
	total: string;
	_rawStatus: string;
	_rawPriority: Priority;
};

export default function JobsPage() {
	const navigate = useNavigate();
	const location = useLocation();

	//permissions
	const CREATE_JOB = usePermission("create_jobs");
	const MANAGE_RECURRING_PLAN = usePermission("manage_recurring_plans");

	const {
		data: recurringPlans,
		isLoading: plansLoading,
		error: plansError,
	} = useAllRecurringPlansQuery(MANAGE_RECURRING_PLAN);
	const { mutateAsync: createJob } = useCreateJobMutation();
	const [isCreateJobModalOpen, setIsCreateJobModalOpen] = useState(false);
	const [isCreatePlanModalOpen, setIsCreatePlanModalOpen] = useState(false);
	const [searchInput, setSearchInput] = useState("");
	const [viewMode, setViewMode] = useState<JobsView>("jobs");
	const report = usePageReport(
		viewMode === "templates" ? "recurring_plans" : "jobs",
		viewMode === "templates" ? "Recurring plans report" : "Jobs report",
		// The plans list is empty without this permission; don't report on it.
		{ allowed: viewMode !== "templates" || MANAGE_RECURRING_PLAN },
	);
	const { terms, addTerm, removeTerm, duplicateTerm } = useMultiSearch("search");
	// The search chips and the text being typed go to the server as one string it splits into words.
	const q = useDebouncedValue([...terms, searchInput.trim()].filter(Boolean).join(" "));
	const { removeTerm: removeStatus } = useMultiSearch("status");
	const dateChip = useDateRangeChip("date");
	const { removeTerm: removePriority } = useMultiSearch("priority");
	const [showActionsMenu, setShowActionsMenu] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	const queryParams = new URLSearchParams(location.search);
	const clientFilter = queryParams.get("client");
	// Repeated (?status=A&status=B, what the filter writes) or comma-joined.
	const flat = (key: string) =>
		queryParams.getAll(key).flatMap((v) => v.split(",").map((s) => s.trim()).filter(Boolean));
	const statusFilter = flat("status");
	const statusKey = statusFilter.join(",");
	const priorityFilter = flat("priority");
	const priorityKey = priorityFilter.join(",");
	const viewParam = queryParams.get("view") as JobsView | null;
	const dateParamKey = queryParams.get("date");
	const dateParamFrom = queryParams.get("dateFrom");
	const dateParamTo = queryParams.get("dateTo");
	const rawSort = queryParams.get("sort");
	const sortParam = rawSort && SERVER_SORT[rawSort] ? rawSort : null;
	const dirParam = queryParams.get("dir");

	const { data: filterClient } = useClientByIdQuery(clientFilter);

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
			priority: priorityFilter.length ? priorityFilter : undefined,
			client_id: clientFilter ?? undefined,
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [q, statusKey, priorityKey, clientFilter, sortParam, dirParam, dateParamKey, dateParamFrom, dateParamTo]);

	const { page, limit, paginationProps } = useListPaging(filters);
	const { priority, client_id, ...listFilters } = filters;
	const params: ListParams = { page, limit, ...listFilters };
	// Not usePagedList: the Templates view lists plans, so the jobs request waits for the Jobs view.
	const {
		data,
		isLoading: jobsLoading,
		isFetching,
		error: jobsError,
	} = useQuery({
		queryKey: [...qk.jobs.list(), { priority, client_id }, params],
		queryFn: () => getJobsPage(params, { priority, client_id }),
		placeholderData: keepPreviousData,
		enabled: (viewParam ?? "jobs") === "jobs",
	});
	const total = data?.total ?? 0;

	const isFetchLoading =
		viewMode === "templates" ? MANAGE_RECURRING_PLAN && plansLoading : jobsLoading;
	const fetchError =
		viewMode === "templates" ? (MANAGE_RECURRING_PLAN ? plansError : null) : jobsError;

	// Close menu on outside click
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

	useEffect(() => {
		setViewMode(viewParam || "jobs");
	}, [viewParam]);

	const templatesDisplay = useMemo(() => {
		const _dp = new URLSearchParams();
		if (dateParamKey) _dp.set("date", dateParamKey);
		if (dateParamFrom) _dp.set("dateFrom", dateParamFrom);
		if (dateParamTo) _dp.set("dateTo", dateParamTo);
		const dateRange = parseDateRangeFromParams(_dp, "date");

		const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;

	// TEMPLATES VIEW - Show only recurring plan templates
	let templatesData =
		recurringPlans?.map((plan) => {
			const upcomingOccurrences = (plan.occurrences || [])
				.filter(
					(occ) =>
						new Date(occ.occurrence_start_at) >
							new Date() &&
						(occ.status === "planned" ||
							occ.status === "generated")
				)
				.sort(
					(a, b) =>
						new Date(
							a.occurrence_start_at
						).getTime() -
						new Date(
							b.occurrence_start_at
						).getTime()
				);

			let scheduleDisplay = "No occurrences";
			let scheduleDate: Date | null = null;

			if (upcomingOccurrences.length > 0) {
				const nextOccurrence = upcomingOccurrences[0];
				scheduleDisplay = `NEXT\n${formatDate(
					nextOccurrence.occurrence_start_at
				)}`;
				scheduleDate = new Date(
					nextOccurrence.occurrence_start_at
				);
			} else if (plan.status === "Completed") {
				scheduleDisplay = "COMPLETED";
			} else if (plan.status === "Cancelled") {
				scheduleDisplay = "CANCELLED";
			} else if (plan.status === "Expired") {
				scheduleDisplay = "EXPIRED";
			}

			const templateTotal =
				plan.line_items?.reduce(
					(sum, item) =>
						sum +
						item.quantity * item.unit_price,
					0
				) || 0;

			return {
				id: plan.id,
				client: plan.client?.name || "Unknown Client",
				title: plan.name,
				property: plan.address || "No address",
				schedule: scheduleDisplay,
				status: addSpacesToCamelCase(plan.status),
				templateTotal: formatCurrency(templateTotal),
				_rawStatus: plan.status,
				_scheduleDate: scheduleDate,
				_clientId: plan.client_id,
				_recurringPlanId: plan.id,
				_startsAt: new Date(plan.starts_at),
				_endsAt: plan.ends_at ? new Date(plan.ends_at) : null,
			};
		}) || [];

	if (clientFilter) {
		templatesData = templatesData.filter(
			(item) => item._clientId === clientFilter
		);
	}

	if (statusFilter.length > 0) {
		templatesData = templatesData.filter(
			(item) => statusFilter.includes(item._rawStatus)
		);
	}

	if (activeTerms.length > 0) {
		templatesData = templatesData.filter((item) =>
			activeTerms.every((term) => {
				const lower = term.toLowerCase();
				return (
					item.title?.toLowerCase().includes(lower) ||
					item.client?.toLowerCase().includes(lower) ||
					item.property?.toLowerCase().includes(lower) ||
					item.status?.toLowerCase().includes(lower)
				);
			})
		);
	}

	if (dateRange.option !== "all") {
		// A plan's date is when it's in effect, not its next visit: "Today" means
		// every plan running today.
		templatesData = templatesData.filter((item) =>
			overlapsDateRange(item._startsAt, item._endsAt, dateRange)
		);
	}

	return templatesData
		.sort((a, b) => {
			// Sort by status
			const statusDiff =
				RecurringPlanStatusValues.indexOf(
					a._rawStatus as RecurringPlanStatus
				) -
				RecurringPlanStatusValues.indexOf(
					b._rawStatus as RecurringPlanStatus
				);
			if (statusDiff !== 0) return statusDiff;

			// Then by schedule date (nulls last)
			if (a._scheduleDate && b._scheduleDate) {
				return (
					a._scheduleDate.getTime() -
					b._scheduleDate.getTime()
				);
			}
			if (a._scheduleDate) return -1;
			if (b._scheduleDate) return 1;

			return 0;
		})
		.map(
			({
				_scheduleDate,
				_clientId,
				_recurringPlanId,
				...rest
			}) => rest
		);

	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [recurringPlans, searchInput, terms, clientFilter, statusKey, dateParamKey, dateParamFrom, dateParamTo]);

	const jobsDisplay = useMemo(
		() =>
			(data?.rows ?? []).map((j) => {
				let scheduleDisplay = "No visits";
				if (j.status === "Completed") {
					if (j.completed_at) scheduleDisplay = `COMPLETED\n${formatDate(j.completed_at)}`;
				} else if (j.visits?.[0]) {
					scheduleDisplay = formatDate(j.visits[0].scheduled_start_at);
				}
				const name = `${j.job_number}\n${j.name}`;
				return {
					id: j.id,
					jobNumber: j.recurring_plan_id ? `🔄 ${name}` : name,
					client: j.client?.name || "Unknown Client",
					property: j.address || "No address",
					schedule: scheduleDisplay,
					status: addSpacesToCamelCase(j.status),
					priority: PriorityLabels[j.priority] || j.priority,
					total: formatCurrency(Number(j.estimated_total || j.actual_total || 0)),
					_rawStatus: j.status,
					_rawPriority: j.priority,
				};
			}),
		[data]
	);

	const display = viewMode === "templates" ? templatesDisplay : jobsDisplay;

	const handleViewModeChange = (mode: JobsView) => {
		setViewMode(mode);
		const newParams = new URLSearchParams(location.search);
		if (mode !== "jobs") {
			newParams.set("view", mode);
		} else {
			newParams.delete("view");
		}
		newParams.delete("status");
		newParams.delete("priority");
		newParams.delete("sort");
		newParams.delete("dir");
		newParams.delete("date");
		newParams.delete("dateFrom");
		newParams.delete("dateTo");
		navigate(`/dispatch/jobs?${newParams.toString()}`);
	};

	const removeFilter = (filterType: "client") => {
		const newParams = new URLSearchParams(location.search);
		newParams.delete(filterType);
		navigate(`/dispatch/jobs${newParams.toString() ? `?${newParams.toString()}` : ""}`);
	};

	const clearSort = () => {
		const next = new URLSearchParams(location.search);
		next.delete("sort");
		next.delete("dir");
		navigate(`/dispatch/jobs${next.toString() ? `?${next.toString()}` : ""}`);
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
		navigate(`/dispatch/jobs${next.toString() ? `?${next.toString()}` : ""}`);
	};

	const handleSortChange = (col: string) => {
		const key = col;
		const next = new URLSearchParams(location.search);
		if (next.get("sort") === key) {
				next.set("dir", next.get("dir") === "asc" ? "desc" : "asc");
		} else {
				next.set("sort", key);
				next.set("dir", "asc");
		}
		navigate(`/dispatch/jobs?${next.toString()}`);
	};

	return (
		<div className="text-text-primary">
			<PageHeader title="Jobs" subtitle={<PageReportKpis report={report} />}>
				<PageReportButton report={report} />
				{CREATE_JOB && (
					<button
						className="flex items-center gap-2 px-4 py-2 bg-primary-hover hover:enabled:bg-primary-active rounded-md text-sm font-medium text-on-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						onClick={() => setIsCreateJobModalOpen(true)}
					>
						<Plus size={16} />
						New Job
					</button>
				)}
				{MANAGE_RECURRING_PLAN && (
					<button
						className="flex items-center gap-2 px-4 py-2 bg-plan hover:bg-plan-hover text-on-primary rounded-md text-sm font-medium transition-colors"
						onClick={() => setIsCreatePlanModalOpen(true)}
					>
						<Repeat size={16} className="text-on-primary" />
						New Recurring Plan
					</button>
				)}
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
									onClick={() => {
										setShowActionsMenu(
											false
										);
									}}
									className="w-full px-4 py-2 text-left text-sm hover:bg-surface/70 transition-colors flex items-center gap-2"
								>
									<Upload size={16} />
									Import Jobs
								</button>
							</div>
						</div>
					)}
				</div>
			</PageHeader>
			<PageControls
				className="mb-4"
				left={
					<>
						<ContextToggle
							value={viewMode}
							onChange={handleViewModeChange}
						/>
						<SearchBar
							paramKey="search"
							placeholder={
								viewMode === "jobs"
									? "Search jobs..."
									: "Search plans..."
							}
							onValueChange={setSearchInput}
							onSubmit={addTerm}
						/>
					</>
				}
				middle={
					<div className="flex items-center gap-2">
						<StatusFilter
							paramKey="status"
							placeholder="Status"
							options={
								viewMode === "jobs"
									? jobStatusOptions
									: planStatusOptions
							}
						/>
						{viewMode === "jobs" && (
							<StatusFilter
								paramKey="priority"
								placeholder="Priority"
								options={jobPriorityOptions}
							/>
						)}
						<DateRangeFilter
							paramKey="date"
							presets={viewMode === "templates" ? PLAN_DATE_PRESETS : undefined}
						/>
						{viewMode === "jobs" && (
							<SortControl
								options={[
									{ value: "priority", label: "Priority" },
									{ value: "status", label: "Status" },
									{ value: "jobNumber", label: "Job #"},
									{ value: "client", label: "Client"},
									{ value: "total", label: "Total"}
								]}
								defaultDirByField={{ priority: "desc", status: "asc", total: "desc" }}
							/>
						)}
					</div>
				}
				right={null}
			/>

			{/* Filter Bar */}
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
						label: `Status: ${addSpacesToCamelCase(status)}`,
						color: "green" as const,
						classes: JobStatusColors[status as JobStatus],
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
				resultCount={viewMode === "jobs" ? total : display.length}
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
					onRowClick={(row) => {
						if (viewMode === "templates") {
							navigate(
								`/dispatch/recurring-plans/${row.id}`
							);
						} else {
							navigate(`/dispatch/jobs/${row.id}`);
						}
					}}
					columnVisibility={viewMode === "templates" ? undefined : { property: false }}
					// One line per job: a wrapped title plus the address line was ~105px a row.
					columnClamp={viewMode === "jobs" ? { jobNumber: { maxWidth: "20rem", fill: true } } : undefined}
					cellRenderers={{
						jobNumber: (row) => {
							const r = row as JobRow;
							const [firstLine, ...nameLines] = String(r.jobNumber).split("\n");
							const isRecurring = firstLine.startsWith("🔄");
							const number = firstLine.replace(/^🔄\s*/, "");
							return (
								<div className="flex flex-col">
									{/* Jobs view puts the number beside the title: two lines a row, not three. */}
									<div className={viewMode === "jobs" ? "flex min-w-0 items-baseline gap-2" : "flex flex-col"}>
										<span className="shrink-0 font-mono text-xs font-semibold text-primary-text">
											{isRecurring ? "🔄 " : ""}#{number}
										</span>
										<span
											className={`font-medium text-text-primary ${viewMode === "jobs" ? "min-w-0 truncate" : ""}`}
											title={viewMode === "jobs" ? nameLines.join(" ") : undefined}
										>
											{nameLines.join(" ")}
										</span>
									</div>
									<span className={`text-xs text-text-tertiary ${viewMode === "jobs" ? "truncate" : ""}`}>
										{r.property}
									</span>
								</div>
							)
						},
						status: (row) => {
							const r = row as JobRow;
							const colors =
								viewMode === "templates"
									? RecurringPlanStatusColors[r._rawStatus as RecurringPlanStatus]
									: JobStatusColors[r._rawStatus as JobStatus];
							return <div className={`w-fit px-2 py-1 rounded-full border text-sm font-medium text-nowrap ${colors}`}>{r.status}</div>;
						},
						priority: (row) => {
							const r = row as JobRow;
							return <div className={`w-fit px-2 py-1 rounded-md border text-sm font-medium ${PriorityColors[r._rawPriority]}`}>{r.priority}</div>;
						},
					}}
					sortableColumns={
						{
							status: true,
							priority: true,
							client: true,
							jobNumber: true,
							total: true,
						}
					}
					sortKey={sortParam ?? ""}
					sortDir={dirParam === "asc" ? "asc" : "desc"}
					onSortChange={handleSortChange}
				/>
				{viewMode === "jobs" && <ReportPagination {...paginationProps(total, isFetching)} />}
			</div>

			<CreateJob
				isModalOpen={isCreateJobModalOpen}
				setIsModalOpen={setIsCreateJobModalOpen}
				createJob={async (input) => {
					const newJob = await createJob(input);

					if (!newJob?.id)
						throw new Error(
							"Job creation failed: no ID returned"
						);

					navigate(`/dispatch/jobs/${newJob.id}`);

					return newJob.id;
				}}
			/>

			<CreateRecurringPlan
				isModalOpen={isCreatePlanModalOpen}
				setIsModalOpen={setIsCreatePlanModalOpen}
			/>
		</div>
	);
}
