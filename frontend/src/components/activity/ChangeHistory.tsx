import { CHANGE_HISTORY_PAGE_SIZE, CHANGE_HISTORY_REFETCH_MS, useChangeHistory } from "../../hooks/useChangeHistory";
import { resolveRoute, timeAgo } from "../../components/dashboard/activityFormat";
import { CalendarDays, RefreshCw } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../../auth/authStore";
import { FALLBACK_TIMEZONE } from "../../util/util";
import { ACTION_FILTERS, actionFilterKeyFor, entityLabelFor, formatChange, type RefType } from "./changeFormat";
import Card from "../ui/Card";
import { HEADER_BTN_ICON } from "../ui/headerActions";
import type { ChangeScope } from "../../types/logs";
import { useClientByIdQuery } from "../../hooks/useClients";
import { useProjectByIdQuery } from "../../hooks/useProjects";
import { useDispatcherByIdQuery } from "../../hooks/useDispatchers";
import { useOrgRoleByIdQuery } from "../../hooks/useOrgRoles";
import { useJobByIdQuery } from "../../hooks/useJobs";
import { useAnyPermission, usePermission } from "../../hooks/usePermission";
import { useRecurringPlanByIdQuery } from "../../hooks/useRecurringPlans";

interface ChangeHistoryProps {
    scope: ChangeScope;
    subjectName?: string;
    title?: string;
    pageSize?: number;
    asCard?: boolean;
}

// Shown when the viewer can't resolve a reference (no permission for the lookup route).
const shortId = (id: string): string => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

// Name lookups never retry: a 403/404 here is final and a retry storm per row is worse
// than showing the id.
function ClientRefName({ id }: { id: string }) {
    const { data } = useClientByIdQuery(id, { retry: false });
    return <>{data?.name ?? id}</>;
}

function ProjectRefName({ id }: { id: string }) {
    const { data } = useProjectByIdQuery(id);
    return <>{data?.name ?? id}</>;
}

function DispatcherRefName({ id }: { id: string }) {
    const { data } = useDispatcherByIdQuery(id);
    return <>{data?.name ?? id}</>;
}

function OrgRoleRefName({ id }: { id: string }) {
    const { data } = useOrgRoleByIdQuery(id);
    return <>{data?.name ?? id}</>;
}

function JobRefName({ id }: { id: string }) {
    const { data } = useJobByIdQuery(id, { retry: false });
    return <>{data?.name ?? id}</>;
}

function RecurringPlanRefName({id}: {id: string}) {
    const {data} = useRecurringPlanByIdQuery(id);
    return <>{data?.name ?? id}</>
}

function RefValue({ refType, id }: { refType: RefType; id: string }) {
    const canViewClients = usePermission("view_clients");
    const canViewProjects = usePermission("view_projects");
    const canManageRoles = usePermission("manage_roles");
    const canViewJobs = useAnyPermission(["view_jobs", "view_assigned_jobs", "view_all_jobs"]);
    const canViewRecurringPlans = usePermission("view_recurring_plans");

    switch (refType) {
        case "client": return canViewClients ? <ClientRefName id={id} /> : <>{shortId(id)}</>;
        case "project": return canViewProjects ? <ProjectRefName id={id} /> : <>{shortId(id)}</>;
        case "dispatcher": return <DispatcherRefName id={id} />;
        case "organization_role": return canManageRoles ? <OrgRoleRefName id={id} /> : <>{shortId(id)}</>;
        case "job": return canViewJobs ? <JobRefName id={id} /> : <>{shortId(id)}</>;
        case "recurring_plan": return canViewRecurringPlans ? <RecurringPlanRefName id={id}/> : <>{shortId(id)}</>;
    }
}

export default function ChangeHistory({ scope, title, pageSize = CHANGE_HISTORY_PAGE_SIZE }: ChangeHistoryProps) {
    const navigate = useNavigate();
    const [limit, setLimit] = useState(pageSize);
    const [activeActions, setActiveActions] = useState<Set<string>>(
        () => new Set(ACTION_FILTERS.map((f) => f.key))
    );

    useEffect(() => {
        setLimit(pageSize);
        setActiveActions(new Set(ACTION_FILTERS.map((f) => f.key)));
    }, [scope.kind, scope.type, scope.id, pageSize]);

    const {
        data: changeHistory,
        isLoading: historyLoading,
        isFetching: historyFetching,
        refetch: refetchHistory,
    } = useChangeHistory(scope, limit);
	const historyLogs = changeHistory?.data ?? [];
    const hasMore = changeHistory?.hasMore ?? false;
    const total = changeHistory?.total ?? 0;
    const { user } = useAuthStore();
    const tz = user?.orgTimezone ?? FALLBACK_TIMEZONE;

    const toggleAction = (key: string) => {
        setActiveActions((prev) => {
            const newSet = new Set(prev);
            if (newSet.has(key)) newSet.delete(key);
            else newSet.add(key);
            return newSet;
        })
    }

    const allEntries = historyLogs
        .map((log) => ({ log, entry: formatChange(log, tz) }))
        .filter(({ log, entry }) => {
            const isCreate = log.action === "created" || log.action === "create";
            if (scope.kind === "entity" && isCreate && log.entity_type === scope.type) return false;
            return entry.rows.length > 0 || log.action !== "updated";
    });

    // Chips filter only the rows loaded so far — the server page is unfiltered, so the
    // footer stays visible whenever there is more to load.
    const entries = allEntries.filter(({ log }) => activeActions.has(actionFilterKeyFor(log)));
    const visibleCount = entries.length;
    const loadedCount = historyLogs.length;

    return (
        <Card
            title={title ?? "Change History"}
            headerAction={
                <button
                    type="button"
                    onClick={() => refetchHistory()}
                    disabled={historyFetching}
                    title={`Refresh now — refreshes on its own every ${CHANGE_HISTORY_REFETCH_MS / 1000}s`}
                    aria-label="Refresh change history"
                    className={HEADER_BTN_ICON}
                >
                    <RefreshCw size={14} className={historyFetching ? "animate-spin" : ""} />
                </button>
            }
        >
            <div>
                <div className="flex flex-wrap items-center gap-1 pb-3 mb-1">
                    {ACTION_FILTERS.map((f) => {
                        const active = activeActions.has(f.key);
                        const Icon = f.icon;

                        return (
                            <button 
                                key={f.key}
                                onClick={() => toggleAction(f.key)}
                                aria-pressed={active}
                                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors hover:cursor-pointer
                                    ${active? `${f.bg} ${f.color}` : "text-text-muted hover:text-text-secondary hover:bg-surface-raised"}`}
                            >
                                <Icon size={11} aria-hidden="true" />
                                {f.label}
                            </button>
                        );
                    })}
                </div>
                {historyLoading ? (
                    <p>Loading Change History</p>
                ) : entries.length === 0 ? (
                    <div className="rounded-lg border border-border-subtle bg-base px-4 py-8 text-center">
                        <CalendarDays size={20} className="mx-auto text-text-muted mb-2" />
                        <p className="text-sm text-text-muted">
                            {allEntries.length > 0 ? "No changes match the selected filters." : "No recent changes."}
                        </p>
                    </div>
                ) : (
                    <div className="rounded-lg border border-border-subtle bg-base divide-y divide-border-subtle overflow-y-scroll max-h-100">
                        {entries.map(({ log, entry }) => {
                                const route = resolveRoute(log);

                                return (
                                    <div 
                                        key={log.id} 
                                        onClick={() => route && navigate(route)}
                                        className={`flex items-start gap-3 px-4 py-3 ${route ? "cursor-pointer hover:bg-surface-raised transition-colors" : ""}`}
                                    >
                                        <div className={`w-7 h-7 rounded-lg ${entry.bg} flex items-center justify-center shrink-0 mt-0.5`}>
                                            <entry.icon size={13} className={entry.color} />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <p className="text-[10px] font-semibold uppercase tracking-wide text-text-faint">
                                                {entityLabelFor(log.entity_type)}
                                            </p>
                                            <p className="text-sm text-text-primary leading-snug">{entry.headline} by {log.actor_name ?? "-"}</p>
                                            {entry.subtitle && (
                                                <p className="text-xs text-text-muted mt-0.5 truncate">{entry.subtitle}</p>
                                            )}
                                            {entry.rows.length > 0 && (
                                                <div className="mt-2 grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-1">
                                                    {entry.rows.map((row) => (
                                                        <Fragment key={row.key}>
                                                            <span className="text-xs text-text-muted pt-px">{row.label}</span>
                                                            <span className="text-xs flex flex-wrap items-baseline gap-1.5 min-w-0">
                                                                {row.from !== "—" && (
                                                                    <>
                                                                        <span className="text-text-muted break-words">
                                                                            {row.refType ? <RefValue refType={row.refType} id={row.from} /> : row.from}
                                                                        </span>
                                                                        <span className="text-text-faint shrink-0">→</span>
                                                                    </>
                                                                )}
                                                                <span className="text-text-primary break-words">
                                                                    {row.refType && row.to !== "—" ? <RefValue refType={row.refType} id={row.to} /> : row.to}
                                                                </span>
                                                            </span>
                                                        </Fragment>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                        <span className="text-xs text-text-muted shrink-0 pt-0.5">{timeAgo(log.timestamp)}</span>
                                    </div>
                                );
                        })}
                    </div>
                )}
                {!historyLoading && (entries.length > 0 || hasMore) && (
                    <div className="flex items-center justify-between gap-3 mt-3">
                        <span className="text-xs text-text-muted">
                            {`Showing ${visibleCount} of ${loadedCount} loaded`}
                            {hasMore ? ` · ${total} total` : ""}
                        </span>
                        {hasMore && (
                            <button
                                type="button"
                                onClick={() => setLimit((l) => l + pageSize)}
                                disabled={historyFetching}
                                className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface hover:bg-surface-raised text-text-secondary border border-border disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                {historyFetching ? "Loading…" : "Show more"}
                            </button>
                        )}
                    </div>
                )}
            </div>
        </Card>
    )
}