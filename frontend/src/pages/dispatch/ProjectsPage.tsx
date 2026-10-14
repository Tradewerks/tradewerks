import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useProjectsQuery, useCreateProjectMutation } from "../../hooks/useProjects";
import { useClientByIdQuery } from "../../hooks/useClients";
import PageReportSection from "../../components/reports/PageReportSection";
import StatusFilter from "../../components/ui/StatusFilter";
import SortControl from "../../components/ui/SortControl";
import DateRangeFilter from "../../components/ui/DateRangeFilter";
import SearchBar from "../../components/ui/SearchBar";
import PageHeader from "../../components/ui/PageHeader";
import { usePermission } from "../../hooks/usePermission";
import { Plus, Briefcase } from "lucide-react";
import PageControls from "../../components/ui/PageControls";
import FilterChips from "../../components/ui/FilterChips";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import { 
    ProjectStatusValues, 
    ProjectStatusLabels, 
    type Project, 
    type ProjectStatus, 
    ProjectStatusColors 
} from "../../types/project";
import { PriorityValues, PriorityLabels, type Priority, PriorityColors } from "../../types/common";
import { matchesDateRange, parseDateRangeFromParams, toLocalDate } from "../../util/dateRangeUtils";
import { compareByOrder, compareDateNullsLast, comparePriority, compareString, compareNumber, withDir, type SortDir } from "../../util/sortUtil";
import { formatCurrency, formatDateOnly } from "../../util/util";
import AdaptableTable from "../../components/AdaptableTable";
import CreateProjectModal from "../../components/projects/CreateProjectModal";

const projectStatusOptions = ProjectStatusValues.map((s) => ({
    value: s,
    label: ProjectStatusLabels[s] ?? s,
}));

const projectPriorityOptions = PriorityValues.map((p) => ({
    value: p,
    label: PriorityLabels[p] ?? p,
}));

const sortLabels: Record<string, string> = {
    priority: "Priority",
    status: "Status",
    date: "Date",
    targetDate: "Target Date",
    client: "Client",
    projectNumber: "Project #",
    jobs: "Jobs",
    budget: "Budget",
    actual: "Actual Spend",
    variance: "Variance",
};

// "targetEnd" is the displayed column; the existing "targetDate" sort key
// already drives it (shared with the SortControl "Target Date" option).
// "budget" is the displayed "Actual / Budget" column — clicking it sorts by
// actual spend (budget itself stays selectable via the SortControl dropdown
// only, since there's no header of its own for it).
const COLUMN_SORT_KEY: Record<string, string> = {
    targetEnd: "targetDate",
    budget: "actual",
};

function computeProjectSpend(p: Project): { actual: number; budget: number | null; variance: number | null } {
    const actual = p.jobs?.reduce((acc, j) => acc + Number(j.actual_total ?? 0), 0) ?? 0;
    const budget = p.budget === null || p.budget === undefined ? null : Number(p.budget);
    const variance = budget === null ? null : budget - actual;
    return { actual, budget, variance };
}

type ProjectRow = {
    id: string;
    projectNumber: string;
    _property: string;
    status: ProjectStatus;
    priority: Priority;
    jobs: string;
    budget: string;
    variance: string;
    targetEnd: string;
    _name: string;
    _actual: number;
    _budget: number | null;
    _variance: number | null;
};

export default function ProjectsPage() {
    const navigate = useNavigate();
    const [createProjectModalOpen, setIsCreateProjectModalOpen] = useState(false);
    const createProjectMutation = useCreateProjectMutation();
    const { data: projects, isLoading: isFetchLoading, error: fetchError } = useProjectsQuery();
    const [searchInput, setSearchInput] = useState("");

    const { terms, addTerm, removeTerm, duplicateTerm } = useMultiSearch("search");
    const { removeTerm: removeStatus } = useMultiSearch("status");
    const { removeTerm: removePriority } = useMultiSearch("priority");
    // Terms can contain any character, so a delimiter-free join could collide; JSON is unambiguous.
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
    const targetDateParamKey = queryParams.get("targetDate");
    const targetDateParamFrom = queryParams.get("targetDateFrom");
    const targetDateParamTo = queryParams.get("targetDateTo");
	const sortParam = queryParams.get("sort");
	const dirParam = queryParams.get("dir");
    
    const { data: filterClient } = useClientByIdQuery(clientFilter);

    // permissions
    const CREATE_PROJECTS = usePermission("create_projects");

    const display = useMemo(() => {
        if (!projects) return [];

        const _dp = new URLSearchParams();
        if (dateParamKey) _dp.set("date", dateParamKey);
        if (dateParamFrom) _dp.set("dateFrom", dateParamFrom);
        if (dateParamTo) _dp.set("dateTo", dateParamTo);
        const dateRange = parseDateRangeFromParams(_dp, "date");
        if (targetDateParamKey) _dp.set("targetDate", targetDateParamKey);
        if (targetDateParamFrom) _dp.set("targetDateFrom", targetDateParamFrom);
        if (targetDateParamTo) _dp.set("targetDateTo", targetDateParamTo);
        const targetDateRange = parseDateRangeFromParams(_dp, "targetDate");

        const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;

        let filtered: Project[] = projects;
        
        if (clientFilter) {
			filtered = projects.filter((p) => p.client_id === clientFilter);
		}

		if (statusFilter.length > 0) {
			filtered = filtered.filter((p) => statusFilter.includes(p.status));
		}

		if (priorityFilter.length > 0) {
			filtered = filtered.filter((p) => priorityFilter.includes(p.priority));
		}

		if (activeTerms.length > 0) {
			filtered = filtered.filter((p) =>
				activeTerms.every((term) => {
					const lower = term.toLowerCase();
					const clientName = p.client?.name?.toLowerCase() || "";
					const title = p.name?.toLowerCase() || "";
					const projectNumber = p.project_number?.toLowerCase() || "";
					const status = p.status?.toLowerCase() || "";
					const address = p.address?.toLowerCase() || "";
					const priority = p.priority?.toLowerCase() || "";
					return (
						title.includes(lower) ||
						clientName.includes(lower) ||
						projectNumber.includes(lower) ||
						status.includes(lower) ||
						address.includes(lower) ||
						priority.includes(lower)
					);
				})
			);
		}

		if (dateRange.option !== "all") {
            filtered = filtered.filter((p) =>
                matchesDateRange(p.created_at ? new Date(p.created_at) : null, dateRange)
            );
        }

        if (targetDateRange.option !== "all") {
            filtered = filtered.filter((p)=> 
                matchesDateRange(p.target_end_at ? toLocalDate(new Date(p.target_end_at)): null, targetDateRange)
            );
        }

        const dir: SortDir = dirParam === "asc" ? "asc" : "desc";
        const comparator: (a: Project, b: Project) => number =
            sortParam === "priority"
                ? withDir((a, b) => comparePriority(a.priority, b.priority), dir)
                : sortParam === "status"
                ? withDir((a, b) => compareByOrder(a.status, b.status, ProjectStatusValues), dir)
                : sortParam === "date"
                ? (a, b) => compareDateNullsLast(dir)(a.created_at, b.created_at)
                : sortParam === "targetDate"
                ? (a, b) => compareDateNullsLast(dir)(a.target_end_at, b.target_end_at)
                : sortParam === "client"
                ? withDir((a, b) => compareString(a.client?.name, b.client?.name), dir)
                : sortParam === "projectNumber"
                ? withDir((a, b) => compareString(a.project_number, b.project_number), dir)
                : sortParam === "jobs"
                ? withDir((a, b) => compareNumber(a.jobs?.length ?? 0, b.jobs?.length ?? 0), dir)
                : sortParam === "budget"
                ? withDir((a, b) => compareNumber(computeProjectSpend(a).budget, computeProjectSpend(b).budget), dir)
                : sortParam === "actual"
                ? withDir((a, b) => compareNumber(computeProjectSpend(a).actual, computeProjectSpend(b).actual), dir)
                : sortParam === "variance"
                ? withDir((a, b) => compareNumber(computeProjectSpend(a).variance, computeProjectSpend(b).variance), dir)
                : (a, b) => {
                    const statusDiff =
                    ProjectStatusValues.indexOf(a.status as ProjectStatus) -
                    ProjectStatusValues.indexOf(b.status as ProjectStatus);
                if (statusDiff !== 0) return statusDiff;

                return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
            }
        return filtered
            .slice()
            .sort(comparator)
            .map((p) => {
                const jobCount = p.jobs?.length ?? 0;
                const { actual, budget, variance } = computeProjectSpend(p);
                return ({
                    id: p.id,
                    projectNumber: p.project_number,   
                    client: p.client?.name || "-",
                    _property: p.address || "No address",
                    status: p.status,                  
                    priority: p.priority,              
                    jobs: String(jobCount),
                    budget: "",                        
                    variance: "",                      
                    targetEnd: p.target_end_at ? formatDateOnly(p.target_end_at) : "—",
                    _name: p.name, _actual: actual, _budget: budget, _variance: variance,
            })});
    }, [projects, termsKey, clientFilter, statusKey, priorityKey, dateParamKey, dateParamFrom, dateParamTo, sortParam, dirParam, searchInput, targetDateParamKey, targetDateParamFrom, targetDateParamTo]);

    const removeFilter = (filterType: "client" | "request") => {
		const newParams = new URLSearchParams(location.search);
		newParams.delete(filterType);
		navigate(`/dispatch/projects${newParams.toString() ? `?${newParams.toString()}` : ""}`);
	};

	const clearSort = () => {
		const next = new URLSearchParams(location.search);
		next.delete("sort");
		next.delete("dir");
		navigate(`/dispatch/projects${next.toString() ? `?${next.toString()}` : ""}`);
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
		navigate(`/dispatch/projects?${next.toString()}`);
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
		next.delete("targetDate");
		next.delete("targetDateFrom");
		next.delete("targetDateTo");
		next.delete("sort");
		next.delete("dir");
		navigate(`/dispatch/projects${next.toString() ? `?${next.toString()}` : ""}`);
	};

    return (
        <div>
            <PageHeader title="Projects">
                {CREATE_PROJECTS && (
                    <button
                        className="flex items-center gap-2 px-4 py-2 bg-primary-hover hover:enabled:bg-primary-active rounded-md text-sm font-medium text-on-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        onClick={() => setIsCreateProjectModalOpen(true)}
                    >
                        <Plus size={16} />
                        New Project
                    </button>
                )}
            </PageHeader>
            <PageReportSection page="projects" label="Projects report" />
            <PageControls
                className="mb-3"
                left={
                    <SearchBar
                        paramKey="search"
                        placeholder="Search projects..."
                        onValueChange={setSearchInput}
                        onSubmit={addTerm}
                    />
                }
                middle={
                    <div className="flex items-center gap-2">
                        <StatusFilter paramKey="status" placeholder="Status" options={projectStatusOptions} />
                        <StatusFilter paramKey="priority" placeholder="Priority" options={projectPriorityOptions} />
                        <DateRangeFilter paramKey="date" label="Created Date" />
                        <DateRangeFilter paramKey="targetDate" label="Target Date" direction="future" />
                        <SortControl
                            options={[
                                { value: "priority", label: "Priority" },
                                { value: "status", label: "Status" },
                                { value: "date", label: "Date" },
                                { value: "targetDate", label: "Target Date"},
                                { value: "client", label: "Client"},
                                { value: "projectNumber", label: "Project #"},
                                { value: "jobs", label: "Jobs"},
                                { value: "budget", label: "Budget"},
                                { value: "actual", label: "Actual Spend"},
                                { value: "variance", label: "Variance"},
                            ]}
                            defaultDirByField={{ priority: "desc", status: "asc", date: "desc", targetDate: "asc", jobs: "desc", budget: "desc", actual: "desc", variance: "asc" }}
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
                        label: `Status: ${ProjectStatusLabels[status as keyof typeof ProjectStatusLabels] ?? status}`,
                        color: "green" as const,
                        classes: ProjectStatusColors[status as ProjectStatus],
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
					onRowClick={(row) => navigate(`/dispatch/projects/${row.id}`)}
                    headerLabels={{
                        projectNumber: "Project",
                        budget: "Actual / Budget",
                        variance: "Variance",
                        targetEnd: "Target End",
                        jobs: "Jobs",
                    }}
                    columnAlign={{ variance: "right", targetEnd: "right" }}
                    cellRenderers={{
                        projectNumber: (row) => {
                            const r = row as ProjectRow;
                            return (
                                <div className="flex flex-col">
                                    <span className="font-mono text-xs font-semibold text-primary-text">
                                        #{r.projectNumber}
                                    </span>
                                    <span className="font-medium text-text-primary">{r._name}</span>
                                    <span className="text-xs text-text-tertiary">{r._property}</span>
                                </div>
                            )
                        },
                        status: (row) => {
                            const r = row as ProjectRow;
                            return <div className={`w-fit px-2 py-1 rounded-full border text-sm font-medium text-nowrap ${ProjectStatusColors[r.status]}`}>{ProjectStatusLabels[r.status]}</div>;
                        },
                        priority: (row) => {
                            const r = row as ProjectRow;
                            return <div className={`w-fit px-2 py-1 rounded-md border text-sm font-medium text-nowrap ${PriorityColors[r.priority]}`}>{PriorityLabels[r.priority]}</div>;
                        },
                        jobs: (row) => {
                            const r = row as ProjectRow;
                            return <span className="inline-flex items-center gap-1"><Briefcase size={14} />{r.jobs}</span>;
                        },
                        variance: (row) => {
                            const r = row as ProjectRow;
                            if (r._variance === null) {
                                return <span className="text-text-muted tabular-nums">—</span>;
                            }
                            const pos = r._variance >= 0;
                            return (
                                <span className={`font-semibold tabular-nums ${pos ? "text-success-text" : "text-error-text"}`}>
                                    {pos ? "+" : "-"}{formatCurrency(Math.abs(r._variance))}
                                </span>
                            );
                        },
                        budget: (row) => {
                            const r = row as ProjectRow;
                            if (r._budget === null) {
                                return (
                                    <div className="min-w-[150px]">
                                        <div className="flex justify-between text-xs">
                                            <span className="font-semibold text-text-primary tabular-nums">{formatCurrency(r._actual)}</span>
                                            <span className="text-text-muted">No budget set</span>
                                        </div>
                                    </div>
                                );
                            }
                            const pct = r._budget > 0 ? Math.min((r._actual / r._budget) * 100, 100) : 0;
                            const over = r._actual > r._budget;
                            return (
                                <div className="min-w-[150px]">
                                    <div className="flex justify-between text-xs mb-1">
                                    <span className="font-semibold text-text-primary tabular-nums">{formatCurrency(r._actual)}</span>
                                    <span className="text-text-muted tabular-nums">{formatCurrency(r._budget)}</span>
                                    </div>
                                    <div className="h-1.5 rounded-full bg-surface-inset overflow-hidden">
                                    <div className={`h-full rounded-full ${over ? "bg-error" : "bg-primary"}`} style={{ width: `${pct}%` }} />
                                    </div>
                                </div>
                            )
                        }
                    }}
					sortableColumns={{
						status: true,
						priority: true,
						client: true,
						projectNumber: true,
						jobs: true,
						budget: true,
						variance: true,
						targetEnd: true,
					}}
					sortKey={
						sortParam === "targetDate"
							? "targetEnd"
							: sortParam === "actual"
							? "budget"
							: (sortParam ?? "")
					}
					sortDir={dirParam === "asc" ? "asc" : "desc"}
					onSortChange={handleSortChange}
				/>
			</div>

            {/* Project Modal */}
            <CreateProjectModal
                isModalOpen={createProjectModalOpen}
                setIsModalOpen={setIsCreateProjectModalOpen}
                createProject={async (input) => {
                    const project = await createProjectMutation.mutateAsync(input);
                    navigate(`/dispatch/projects/${project.id}`);
                    return project.id;
                }}
            />
        </div>
    );
}