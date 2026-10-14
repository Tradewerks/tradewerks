import AdaptableTable from "../../components/AdaptableTable";
import { useAllJobsQuery, useCreateJobMutation } from "../../hooks/useJobs";
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
import PageControls from "../../components/ui/PageControls";
import StatusFilter from "../../components/ui/StatusFilter";
import SortControl from "../../components/ui/SortControl";
import DateRangeFilter from "../../components/ui/DateRangeFilter";
import { parseDateRangeFromParams, matchesDateRange } from "../../util/dateRangeUtils";
import ContextToggle, { type JobsView } from "../../components/ui/ContextToggle";
import PageHeader from "../../components/ui/PageHeader";
import { usePermission } from "../../hooks/usePermission";
import PageReportSection from "../../components/reports/PageReportSection";
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

const jobStatusOptions = JobStatusValues.map((s) => ({
	value: s,
	label: addSpacesToCamelCase(s),
}));

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
	date: "Date",
	client: "Client",
	jobNumber: "Job #",
	total: "Total",
};

// Plain-text columns sorted with a generic localeCompare — no domain-specific
// order needed (unlike priority/status). Allowlisted so a stray `sort` value
// from the URL can't index an arbitrary JobRow field.
const SORTABLE_STRING_FIELDS = ["client", "jobNumber"] as const;
type SortableStringField = (typeof SORTABLE_STRING_FIELDS)[number];
function isSortableStringField(value: string | null): value is SortableStringField {
	return (SORTABLE_STRING_FIELDS as readonly string[]).includes(value ?? "");
}

// Column ids whose displayed value isn't the sortable one — the real value
// lives on a `_raw*`/underlying field (formatted currency string vs the raw
// number, a schedule-status blurb vs the raw date). Clicking these headers
// sorts by, and highlights in sync with, the aliased key instead.
const COLUMN_SORT_KEY: Record<string, string> = {
	schedule: "date",
};

type JobRow = {
	id: string;
	isRecurring: string;
	client: string;
	jobNumber: string;
	property: string;
	schedule: string;
	status: string;
	priority: Priority;
	total: number;
	_rawStatus: string;
	_rawPriority: Priority,
	_rawTotal: number;
	_scheduleDate: string;
	_rawJobNumber: string;
	_clientId: string;
	_jobId: string;
};

export default function JobsPage() {
	const navigate = useNavigate();
	const location = useLocation();

	//permissions
	const CREATE_JOB = usePermission("create_jobs");
	const MANAGE_RECURRING_PLAN = usePermission("manage_recurring_plans");

	const { data: jobs, isLoading: jobsLoading, error: jobsError } = useAllJobsQuery();
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
	const { terms, addTerm, removeTerm, duplicateTerm } = useMultiSearch("search");
	const { removeTerm: removeStatus } = useMultiSearch("status");
	const { removeTerm: removePriority } = useMultiSearch("priority");
	// Collision-free memo key (["ab"] vs ["a","b"] must differ)
	const termsKey = JSON.stringify(terms);
	const [showActionsMenu, setShowActionsMenu] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	const queryParams = new URLSearchParams(location.search);
	const clientFilter = queryParams.get("client");
	const statusFilter = queryParams.getAll("status");
	const statusKey = statusFilter.join(",");
	const priorityFilter = queryParams.getAll("priority");
	const priorityKey = priorityFilter.join(",");
	const viewParam = queryParams.get("view") as JobsView | null;
	const dateParamKey = queryParams.get("date");
	const dateParamFrom = queryParams.get("dateFrom");
	const dateParamTo = queryParams.get("dateTo");
	const sortParam = queryParams.get("sort");
	const dirParam = queryParams.get("dir");

	const { data: filterClient } = useClientByIdQuery(clientFilter);

	const isFetchLoading = jobsLoading || (MANAGE_RECURRING_PLAN && plansLoading);
	const fetchError = jobsError || (MANAGE_RECURRING_PLAN ? plansError : null);

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

	const display = useMemo(() => {
		const _dp = new URLSearchParams();
		if (dateParamKey) _dp.set("date", dateParamKey);
		if (dateParamFrom) _dp.set("dateFrom", dateParamFrom);
		if (dateParamTo) _dp.set("dateTo", dateParamTo);
		const dateRange = parseDateRangeFromParams(_dp, "date");

		const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;

		if (viewMode === "templates") {
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
				templatesData = templatesData.filter((item) =>
					matchesDateRange(item._scheduleDate, dateRange)
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
		} else {
			// JOBS VIEW - Show all job containers (one-time + recurring)
			let jobsData =
				jobs?.map((j) => {
					const allVisits = (j.visits || []).sort(
						(a, b) =>
							new Date(a.scheduled_start_at).getTime() -
							new Date(b.scheduled_start_at).getTime()
					);

					let scheduleDisplay = "No visits scheduled";
					let scheduleDate: Date | null = null;

					if (j.status === "Completed") {
						const completedVisits = allVisits
							.filter((v) => v.status === "Completed")
							.sort(
								(a, b) =>
									new Date(
										b.actual_end_at ||
											b.scheduled_end_at
									).getTime() -
									new Date(
										a.actual_end_at ||
											a.scheduled_end_at
									).getTime()
							);

						if (completedVisits.length > 0) {
							const lastVisit = completedVisits[0];
							const completedDate =
								lastVisit.actual_end_at ||
								lastVisit.scheduled_end_at;
							scheduleDisplay = `COMPLETED\n${formatDate(completedDate)}`;
							scheduleDate = new Date(completedDate);
						}
					} else {
						const scheduledVisits = allVisits.filter(
							(v) =>
								v.status === "Scheduled" ||
								v.status === "InProgress"
						);

						if (scheduledVisits.length > 0) {
							const nextVisit = scheduledVisits[0];
							scheduleDisplay = formatDate(
								nextVisit.scheduled_start_at
							);
							scheduleDate = new Date(
								nextVisit.scheduled_start_at
							);
						}
					}

					return {
						id: j.id,
						isRecurring: !!j.recurring_plan_id,
						jobNumber: `${j.job_number}\n${j.name}`,
						client: j.client?.name || "Unknown Client",
						property: j.address || "No address",
						schedule: scheduleDisplay,
						status: addSpacesToCamelCase(j.status),
						priority: PriorityLabels[j.priority] || j.priority,
						total: formatCurrency(
							Number(
								j.estimated_total ||
									j.actual_total ||
									0
							)
						),
						_rawStatus: j.status,
						_rawPriority: j.priority,
						_rawTotal: Number(
							j.estimated_total || j.actual_total || 0
						),
						_scheduleDate: scheduleDate,
						_rawJobNumber: j.job_number,
						_clientId: j.client_id,
						_jobId: j.id,
					};
				}) || [];

			if (clientFilter) {
				jobsData = jobsData.filter(
					(item) => item._clientId === clientFilter
				);
			}

			if (statusFilter.length > 0) {
				jobsData = jobsData.filter(
					(item) => statusFilter.includes(item._rawStatus)
				);
			}

			if (priorityFilter.length > 0) {
				jobsData = jobsData.filter(
					(item) => priorityFilter.includes(item._rawPriority)
				);
			}

			if (activeTerms.length > 0) {
				jobsData = jobsData.filter((item) =>
					activeTerms.every((term) => {
						const lower = term.toLowerCase();
						return (
							item.jobNumber?.toLowerCase().includes(lower) ||
							item.client?.toLowerCase().includes(lower) ||
							item.status?.toLowerCase().includes(lower) ||
							item.property?.toLowerCase().includes(lower)
						);
					})
				);
			}

			if (dateRange.option !== "all") {
				jobsData = jobsData.filter((item) =>
					matchesDateRange(item._scheduleDate, dateRange)
				);
			}

			type JobRow = (typeof jobsData)[number];
			const dir: SortDir = dirParam === "asc" ? "asc" : "desc";
			const comparator: (a: JobRow, b: JobRow) => number =
				sortParam === "priority"
					? withDir((a, b) => comparePriority(a._rawPriority, b._rawPriority), dir)
					: sortParam === "status"
					? withDir((a, b) => compareByOrder(a._rawStatus, b._rawStatus, JobStatusValues), dir)
					: sortParam === "date"
					? (a, b) => compareDateNullsLast(dir)(a._scheduleDate, b._scheduleDate)
					: sortParam === "total"
					? withDir((a, b) => compareNumber(a._rawTotal, b._rawTotal), dir)
					: isSortableStringField(sortParam)
					? withDir((a, b) => compareString(a[sortParam], b[sortParam]), dir)
					: (a, b) => {
							// default: status, then schedule date (nulls last)
							const statusDiff =
								JobStatusValues.indexOf(a._rawStatus as JobStatus) -
								JobStatusValues.indexOf(b._rawStatus as JobStatus);
							if (statusDiff !== 0) return statusDiff;
							if (a._scheduleDate && b._scheduleDate)
								return a._scheduleDate.getTime() - b._scheduleDate.getTime();
							if (a._scheduleDate) return -1;
							if (b._scheduleDate) return 1;
							return 0;
					  };

			return jobsData
				.sort(comparator)
				.map(
					({
						_rawTotal,
						_scheduleDate,
						_rawJobNumber,
						_clientId,
						_jobId,
						isRecurring,
						...rest
					}) => ({
						...rest,
						jobNumber: isRecurring
							? `🔄 ${rest.jobNumber}`
							: rest.jobNumber,
					})
				);
		}
	}, [jobs, recurringPlans, searchInput, termsKey, clientFilter, statusKey, priorityKey, viewMode, dateParamKey, dateParamFrom, dateParamTo, sortParam, dirParam]);

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
		const key = COLUMN_SORT_KEY[col] ?? col;
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
			<PageHeader title="Jobs">
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
			<PageReportSection page="jobs" label="Jobs report" />
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
						<DateRangeFilter paramKey="date" />
						{viewMode === "jobs" && (
							<SortControl
								options={[
									{ value: "priority", label: "Priority" },
									{ value: "status", label: "Status" },
									{ value: "date", label: "Date" },
									{ value: "jobNumber", label: "Job #"},
									{ value: "client", label: "Client"},
									{ value: "total", label: "Total"}
								]}
								defaultDirByField={{ priority: "desc", status: "asc", date: "desc", total: "desc" }}
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
					cellRenderers={{
						jobNumber: (row) => {
							const r = row as JobRow;
							const [firstLine, ...nameLines] = String(r.jobNumber).split("\n");
							const isRecurring = firstLine.startsWith("🔄");
							const number = firstLine.replace(/^🔄\s*/, "");
							return (
								<div className="flex flex-col">
									<span className="font-mono text-xs font-semibold text-primary-text">
										{isRecurring ? "🔄 " : ""}#{number}
									</span>
									<span className="font-medium text-text-primary">{nameLines.join(" ")}</span>
									<span className="text-xs text-text-tertiary">{r.property}</span>
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
							schedule: true,
						}
					}
					sortKey={sortParam === "date" ? "schedule" : (sortParam ?? "")}
					sortDir={dirParam === "asc" ? "asc" : "desc"}
					onSortChange={handleSortChange}
				/>
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
