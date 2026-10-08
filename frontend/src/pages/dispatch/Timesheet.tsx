import { useApproveTimesheetMutation, useTechnicianWeekQuery, useTimesheetsQuery, useUnapproveTimesheetMutation } from "../../hooks/useTimesheets"
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import AdaptableTable from "../../components/AdaptableTable";
import { useMemo, useRef, useState } from "react";
import { useTimesheetsReportQuery } from "../../hooks/useReports";
import PageHeader from "../../components/ui/PageHeader";
import SearchBar from "../../components/ui/SearchBar";
import PageControls from "../../components/ui/PageControls";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import FilterChips from "../../components/ui/FilterChips";
import { useLocation, useNavigate } from "react-router-dom";
import { useToast } from "../../components/ui/useToast";
import { usePermission } from "../../hooks/usePermission";
import { usePushTimesheetToQBMutation, useQBStatusQuery } from "../../hooks/useQuickbooks";
import { formatDate, formatTime, FALLBACK_TIMEZONE } from "../../util/util";
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Clock, Moon, X } from "lucide-react";
import ExportExcelButton from "../../components/reports/ExportExcelButton";
import { datedFilename } from "../../util/download";
import RefreshReportsButton from "../../components/reports/RefreshReportButton";
import { useColumnVisibility, type ColumnOption } from "../../hooks/useColumnVisibility";
import { addDays, camelCaseToRegular, errorMessage, formatWeekRange, startOfWeek } from "../../util/util";
import { exportReport } from "../../api/reports";
import Card from "../../components/ui/Card";
import type { Segment, SegType } from "../../types/timesheets";
import { useAuthStore } from "../../auth/authStore";


const fmtHours = (h: number) => {
    const m = Math.round(h * 60);
    const hh = Math.floor(m / 60);
    const mm = String(m % 60).padStart(2, "0");
    return hh ? `${hh}h ${mm}m` : `${m}m`;
};

const pctOf = (h: number, total: number) =>
    `${total > 0 ? Math.round((h / total) * 100) : 0}% of shift time`;

const visitsHint = (n: number, hours: number, total: number) =>
    `${n} ${n === 1 ? "visit" : "visits"} · ${pctOf(hours, total)}`;

interface StatCard {
	label: string;
	value: string;
	hint?: string;
}

const cols = (...keys: string[]): ColumnOption[] =>
    keys.map((key) => ({ key, label: camelCaseToRegular(key) }));

const SUMMARY_COLS = cols("technician", "shifts", "timeSplit", "grossHours", "breakHours", "payableHours", "status", "qbSync");
const DETAIL_COLS = cols("date", "hours", "jobs", "driving", "payable");

const SPLIT_COLORS = { Jobs: "bg-primary", Driving: "bg-amber-500", Breaks: "bg-slate-600", Unassigned: "bg-border-strong" };

const spanHours = (s: { start: string; end: string }) =>
        (new Date(s.end).getTime() - new Date(s.start).getTime()) / 3_600_000;

type Seg = { label: string; hours: number; className: string };

const SEG_STYLE: Record<SegType, { label: string; className: string }> = {
    job: { label: "Jobs", className: "bg-primary" },
    drive: { label: "Driving", className: "bg-amber-500" },
    break: { label: "Breaks", className: "bg-slate-600" },
    unassigned: { label: "Unassigned", className: "bg-border-strong" },
};

function TimeSplitBar({ segs }: { segs: Seg[] }) {
    const total = segs.reduce((s, x) => s + x.hours, 0);
    if (!total) return null;

    return (
        <div 
            className="flex h-3.5 w-full rounded overflow-hidden bg-surface-raised"
            title={segs.map((s) => `${s.label} ${fmtHours(s.hours)}`).join(" · ")}
        >
            {segs.map((s) => (
                <span 
                    key={s.label}
                    className={`${s.className} `} // shadow-[inset_-1px_0_0_white] personally prefer without shadow
                    style={{ width: `${(s.hours / total) * 100}%`}}
                />
            ))}
        </div>
    )
}

const minsOfDay = (iso: string, tz: string) => {
    const [h, m] = new Date(iso)
        .toLocaleTimeString("en-GB", { timeZone: tz, hour12: false })
        .split(":")
        .map(Number);
    return (h % 24) * 60 + m;
}

// Minutes from midnight of the anchor's day, so overnight times run past 1440.
const minsFrom = (iso: string, anchor: string, tz: string) =>
    minsOfDay(anchor, tz) + (new Date(iso).getTime() - new Date(anchor).getTime()) / 60_000;

// Axis covering the given days, rounded out to even hours.
const axisOf = (days: Segment[][], tz: string): [number, number] => {
    const mins = days.flatMap((segs) =>
        segs.flatMap((s) => [minsFrom(s.start, segs[0].start, tz), minsFrom(s.end, segs[0].start, tz)]),
    );
    if (!mins.length) return [0, 1];
    return [Math.floor(Math.min(...mins) / 120) * 120, Math.ceil(Math.max(...mins) / 120) * 120];
};

const isOvernight = (segs: Segment[], tz: string) =>
    segs.length > 0 && minsFrom(segs[segs.length - 1].end, segs[0].start, tz) > 1440;

function Timeline ({ segments, axis, tz }: { segments: Segment[]; axis: [number, number]; tz: string }) {
    // Overnight shifts get their own axis so they don't stretch the rest of the week.
    const overnight = isOvernight(segments, tz);
    const [from, to] = overnight ? axisOf([segments], tz) : axis;
    const span = to - from || 1;
    const pct = (mins: number) => `${((mins - from) / span) *100}%`;
    const ticks: number[] = [];
    for (let h = Math.ceil(from / 120) * 2; h * 60 <= to; h += 2) ticks.push(h);
    const first = segments[0];
    const last = segments[segments.length - 1];
    return (
        <div className="w-full min-w-48">
            <div className="relative">
            <div className="relative h-3.5 rounded overflow-hidden bg-slate-100">
                {segments.map((s, i) => (
                    <span
                        key={i}
                        title={`${SEG_STYLE[s.type].label} · ${fmtHours(spanHours(s))}`}
                        className={`absolute inset-y-0 ${SEG_STYLE[s.type].className}`}
                        style={{
                            left: pct(minsFrom(s.start, first.start, tz)),
                            width: `${((spanHours(s) * 60) / span) * 100}%`,
                        }}
                    />
                ))}
            </div>
            {overnight && (
                <span
                    title="Midnight"
                    className="absolute -inset-y-1 border-l-2 border-dashed border-text-primary"
                    style={{ left: pct(1440) }}
                />
            )}
            {first && (
                <>
                    <span
                        title={`Shift start ${formatTime(first.start, tz)}`}
                        className="absolute -inset-y-0.5 w-0.5 rounded bg-text-primary ring-2 ring-base p-0.5"
                        style={{ left: pct(minsFrom(first.start, first.start, tz)) }}
                    />
                    <span
                        title={`Shift end ${formatTime(last.end,tz)}`}
                        className="absolute -inset-y-0.5 w-0.5 rounded bg-text-primary ring-2 ring-base -translate-x-full p-0.5"
                        style={{ left: pct(minsFrom(last.end, first.start, tz)) }}
                    />
                </>
            )}
            </div>
            <div className="relative h-4 mt-1 text-[11px] text-text-muted">
                {ticks.map((h, i) => (
                    <span
                            key={h}
                            className={`absolute ${i === 0 ? "" : i === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2"}`}
                            style={{ left: pct(h * 60) }}
                    >
                        {(h % 12 || 12) + (h % 24 < 12 ? "am" : "pm")}
                    </span>
                ))}
            </div>
        </div>
    )
}

function SegmentTable ({ segments, tz }: { segments: Segment[]; tz: string }) {
    const data = useMemo(() => {
        return segments.map((s) => {
            const duration = spanHours(s);
            return {
                time: `${formatTime(s.start, tz)} - ${formatTime(s.end, tz)}`,
                type: s.type,
                detail: s.label,
                duration: fmtHours(duration),
                _sub: s.sub,
            }
        });
    }, [segments, tz])
    return (
        <div className="py-3 px-5">
            <AdaptableTable
                data={data}
                cellRenderers={{
                    type: (row) => {
                        const r = row as Segment;
                        const { label, className } = SEG_STYLE[r.type];
                        return (
                            <span className="inline-flex items-center gap-1.5">
                                <span className={`size-2.5 rounded-sm ${className}`} />
                                {label}
                            </span>
                        )
                    },
                    detail: (row) => {
                        const r = row as { detail: string, _sub: string};
                        return (
                            <span>
                                {r.detail} &nbsp;
                                <span className="text-text-muted">{r._sub}</span>
                            </span>
                        )
                    }
                }}
            />
        </div>
    )
}

export default function Timesheet () {
    const toast = useToast();
    const qbConnected = !!useQBStatusQuery().data?.connected;
    const tz = useAuthStore().user?.orgTimezone ?? FALLBACK_TIMEZONE;
    const navigate = useNavigate();
	const location = useLocation();

	const [searchInput, setSearchInput] = useState("");
	const { terms, addTerm, removeTerm, duplicateTerm } = useMultiSearch("search");

	const queryParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
	const techRaw = queryParams.get("tech");
	const techParam = techRaw ? decodeURIComponent(techRaw) : null;
	const isSummaryView = techParam === null;

    const weekParam = queryParams.get("week");
    const parsedWeek = new Date(`${weekParam}T00:00`);
    const weekStart = startOfWeek(Number.isNaN(parsedWeek.getTime()) ? new Date() : parsedWeek);
    const weekKey = weekStart.toLocaleDateString("en-CA");
    const pickerRef = useRef<HTMLInputElement>(null);

    const setWeek = (day: Date) => {
        const next = new URLSearchParams(location.search);
        next.set("week", startOfWeek(day).toLocaleDateString("en-CA"));
        navigate(`/dispatch/timesheet?${next.toString()}`);
    };

    const { data, isLoading, error } = useTimesheetsReportQuery(
        weekStart.toISOString(),
        addDays(weekStart, 7).toISOString(),
    );
    const records = useMemo(() => data ?? [], [data]);

    const { data: weeks } = useTimesheetsQuery(weekKey);
    const approvedByTech = useMemo(
        () => new Map((weeks ?? []).map((w) => [w.technician_id, w])),
        [weeks],
    );

    const { data: techWeekDetails } = useTechnicianWeekQuery(techParam ?? "", weekKey);

    const CAN_APPROVE = usePermission("manage_timesheet");
    const [confirmApprove, setConfirmApprove] = useState(false);
    const { mutateAsync: approveMutation, isPending: approving } = useApproveTimesheetMutation();
    const { mutateAsync: unapproveMutation, isPending: unapproving } = useUnapproveTimesheetMutation();
    const { mutateAsync: pushTimesheet, isPending: pushing } = usePushTimesheetToQBMutation();
    const handlePush = async (timesheetId: string) => {
        try {
            await pushTimesheet(timesheetId);
            toast.success("Timesheet synced to QuickBooks");
        } catch (err) {
            toast.error(errorMessage(err, "Failed to sync timesheet to QuickBooks"));
        }
    }
    const handleApproval = async (techId: string, approve: boolean) => {
        const verb = approve ? "approve" : "unapprove";
        try {
            await (approve ? approveMutation : unapproveMutation)({ technician_id: techId, date: weekKey });
            setConfirmApprove(false);
            toast.success(`Timesheet ${verb}d`);
        } catch (err) {
            toast.error(errorMessage(err, `Failed to ${verb} timesheet`));
        }
    }


    // ── Summary ──────────────────────────────────────────────────────────
    const { summaryRows, summaryStats } = useMemo(() => {
        const groups = new Map<string, typeof records>();
        for (const r of records) {
            const existing = groups.get(r.technicianId);
            if (existing) existing.push(r);
            else groups.set(r.technicianId, [r]);
        }

        const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;
        const surviving = Array.from(groups.entries()).filter(([, recs]) =>
            activeTerms.every((term) => recs[0].technicianName.toLowerCase().includes(term.toLowerCase())),
        );

        const built = surviving
            .map(([techId, recs]) => {
                const name = recs[0].technicianName;
                const week = approvedByTech.get(techId);
                const grossHours = recs.reduce((s, r) => s + r.grossHours, 0);
                const breakHours = recs.reduce((s, r) => s + r.breakHours, 0);
                const payableHours = recs.reduce((s, r) => s + r.payableHours, 0);
                const visitHours = recs.reduce((s, r) => s + r.visitHours, 0);
                const driveHours = recs.reduce((s, r) => s + r.driveHours, 0);
                return {
                    name,
                    payableHours,
                    row: {
                        id: techId,
                        technician: name,
                        shifts: recs.length,
                        timeSplit: "",
                        grossHours: fmtHours(grossHours),
                        breakHours: fmtHours(breakHours),
                        jobVisitHours: fmtHours(visitHours),
                        unassignedHours: fmtHours(Math.max(0, grossHours - breakHours - visitHours - driveHours)),
                        payableHours: fmtHours(payableHours),
                        status: week?.approved_at ? "Approved" : "Open",
                        ...(qbConnected && { qbSync: week ? week.qb_sync_status : "" }),
                        _grossHours: grossHours, _breakHours: breakHours, _visitHours: visitHours, _driveHours: driveHours,
                    },
                };
            })
            .sort((a, b) => b.payableHours - a.payableHours);

        const survivingRecords = surviving.flatMap(([, recs]) => recs);
        const payableHours = survivingRecords.reduce((s, r) => s + r.payableHours, 0);
        const visitHours = survivingRecords.reduce((s, r) => s + r.visitHours, 0);
        const visitCount = survivingRecords.reduce((s, r) => s + r.visitCount, 0);
        const breakHours = survivingRecords.reduce((s, r) => s + r.breakHours, 0);
        const driveHours = survivingRecords.reduce((s, r) => s + r.driveHours, 0);
        const grossHours = survivingRecords.reduce((s, r) => s + r.grossHours, 0);
        const unassignedHours = Math.max(0, grossHours - breakHours - visitHours - driveHours);
        const shifts = survivingRecords.length;
        const pctOfShift = (h: number) => pctOf(h, grossHours);

        return {
            summaryRows: built.map((b) => b.row),
            summaryStats: [
                {
                    label: "Total Payable Hours",
                    value: fmtHours(payableHours),
                    hint: `${shifts} ${shifts === 1 ? "shift" : "shifts"}`,
                },
                {
                    label: "Avg Payable / Shift",
                    value: fmtHours(shifts > 0 ? payableHours / shifts : 0),
                },
                { label: "Shift Time", value: fmtHours(grossHours), hint: "including breaks" },
                {
                    label: "On Jobs",
                    value: fmtHours(visitHours),
                    hint: visitsHint(visitCount, visitHours, grossHours),
                },
                {
                    label: "Driving",
                    value: fmtHours(driveHours),
                    hint: pctOfShift(driveHours),
                },
                {
                    label: "Breaks",
                    value: fmtHours(breakHours),
                    hint: pctOfShift(breakHours),
                },
                {
                    label: "Unassigned",
                    value: fmtHours(unassignedHours),
                    hint: pctOfShift(unassignedHours),
                },
                { label: "Technicians", value: String(surviving.length), hint: "with time logged" },
            ] as StatCard[],
        };
    }, [records, searchInput, terms, approvedByTech, qbConnected]);

    // ── Detail ───────────────────────────────────────────────────────────
    const { detailRows, detailStats } = useMemo(() => {
        if (isSummaryView) return { detailRows: [], detailStats: [] };

        const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;

        const filtered = records
            .filter((r) => r.technicianId === techParam)
            .filter((r) =>
                activeTerms.every((term) =>
                    formatDate(r.startedAt, tz).toLowerCase().includes(term.toLowerCase()),
                ),
            )
            .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

        const segmentsByShift = new Map(
            (techWeekDetails?.days ?? []).map((d) => [d.shiftId, d.segments]),
        );

        const detailRows = filtered.map((r) => {
            const segs = segmentsByShift.get(r.shiftId) ?? [];
            const sum = (t: SegType) => segs.filter((s) => s.type === t).reduce((h, s) => h + spanHours(s), 0);
            return {
                id: r.shiftId,
                date: formatDate(r.startedAt, tz),
                hours: `${formatTime(r.startedAt, tz)} – ${formatTime(r.endedAt, tz)}`,
                jobs: fmtHours(sum("job")),
                driving: fmtHours(sum("drive")),
                payable: fmtHours(r.payableHours),
                _segments: segs,
                _overnight: isOvernight(segs, tz),
            }
        });

        const payableHours = filtered.reduce((s, r) => s + r.payableHours, 0);
        const shifts = filtered.length;
        const visitHours = filtered.reduce((s, r) => s + r.visitHours, 0);
        const visitCount = filtered.reduce((s, r) => s + r.visitCount, 0);
        const breakHours = filtered.reduce((s, r) => s + r.breakHours, 0);
        const driveHours = filtered.reduce((s, r) => s + r.driveHours, 0);
        const grossHours = filtered.reduce((s, r) => s + r.grossHours, 0);
        const unassignedHours = Math.max(0, grossHours - breakHours - visitHours - driveHours);
        const pctOfShift = (h: number) => pctOf(h, grossHours);

        return {
            detailRows,
            detailStats: [
                { label: "Total Payable Hours", value: fmtHours(payableHours) },
                {
                    label: "Avg Payable / Shift",
                    value: fmtHours(shifts > 0 ? payableHours / shifts : 0),
                },
                { label: "Shift Time", value: fmtHours(grossHours), hint: "including breaks" },
                {
                    label: "On Jobs",
                    value: fmtHours(visitHours),
                    hint: visitsHint(visitCount, visitHours, grossHours),
                },
                {
                    label: "Driving",
                    value: fmtHours(driveHours),
                    hint: pctOfShift(driveHours),
                },
                {
                    label: "Breaks",
                    value: fmtHours(breakHours),
                    hint: pctOfShift(breakHours),
                },
                {
                    label: "Unassigned",
                    value: fmtHours(unassignedHours),
                    hint: pctOfShift(unassignedHours),
                },
                { label: "Shifts", value: String(shifts) },
            ] as StatCard[],
        };
    }, [records, isSummaryView, techParam, searchInput, terms, techWeekDetails, tz]);


    const columnDefs = isSummaryView
        ? SUMMARY_COLS.filter((c) => qbConnected || c.key !== "qbSync")
        : DETAIL_COLS;
    const { columnVisibility, visibleColumns } = useColumnVisibility(
        `timesheets:${isSummaryView ? "summary" : "detail"}`,
        columnDefs,
    );

    const handleBackToSummary = () => {
		setSearchInput("");
		const next = new URLSearchParams(location.search);
		next.delete("tech");
		next.delete("search");
		const qs = next.toString();
		navigate(`/dispatch/timesheet${qs ? `?${qs}` : ""}`);
	};

    const clearAllFilters = () => {
		setSearchInput("");
		const next = new URLSearchParams(location.search);
		next.delete("search");
		const qs = next.toString();
		navigate(`/dispatch/timesheet${qs ? `?${qs}` : ""}`);
	};

    const handleTechClick = (techId: string) => {
		setSearchInput("");
		const next = new URLSearchParams(location.search);
		next.delete("search"); // clear detail-level search when drilling down
		next.set("tech", techId);
		navigate(`/dispatch/timesheet?${next.toString()}`);
	};

    const hasActiveFilters = terms.length > 0;

	const rows = isSummaryView ? summaryRows : detailRows;
	const stats = isSummaryView ? summaryStats : detailStats;
	const showEmpty = rows.length === 0 && !isLoading && !error;
	const techName = techWeekDetails?.technicianName;
	const techWeek = techParam ? approvedByTech.get(techParam) : undefined;
	const techApproved = !!techWeek?.approved_at;
	const techSynced = techWeek?.qb_sync_status === "synced";
	const weekInProgress = addDays(weekStart, 7) > new Date();

    const axis = useMemo((): [number, number] => {
        const days = (techWeekDetails?.days ?? []).map((d) => d.segments);
        return axisOf(days.filter((segs) => !isOvernight(segs, tz)), tz);
    }, [techWeekDetails, tz]);

    return (
        <div>
            <PageHeader
                title={isSummaryView ? "Timesheet" : (techName ?? "Timesheet")}
                subtitle={
					!isSummaryView ? (
						<button
							onClick={handleBackToSummary}
							className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors mt-0.5"
						>
							<ArrowLeft size={14} />
							All Technicians
						</button>
					) : undefined
				}
            >
                {!isSummaryView && CAN_APPROVE && (
                    <button
                        onClick={() => setConfirmApprove(true)}
                        disabled={!techApproved && detailRows.length === 0}
                        className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                            techApproved
                                ? "border border-border-subtle text-text-primary bg-surface hover:enabled:bg-surface-raised"
                                : "bg-primary-hover hover:enabled:bg-primary-active text-on-primary"
                        }`}
                    >
                        {techApproved ? <X size={16} /> : <Check size={16} />}
                        {techApproved ? "Unapprove week" : "Approve week"}
                    </button>
                )}
                {!isSummaryView && CAN_APPROVE && qbConnected && (
                    <button
                        className="ml-1 flex items-center gap-2 border-l border-border py-1.5 pl-3 pr-3 rounded-md text-sm font-medium bg-quickbooks hover:enabled:bg-quickbooks-hover text-white transition-colors duration-150 ease-out disabled:opacity-40 disabled:cursor-not-allowed"
                        onClick={() => techWeek && handlePush(techWeek.id)}
                        disabled={!techApproved || techSynced || pushing}
                        title={
                            !techApproved ? "Approve the week first"
                            : techSynced ? "Synced to QuickBooks"
                            : techWeek?.qb_error ?? undefined
                        }
                    >
                        {techSynced ? "Synced" : pushing ? "Syncing…" : techWeek?.qb_sync_status === "failed" ? "Retry sync" : "Sync to QB"}
                    </button>
                )}
            </PageHeader>

            <ConfirmDialog
                open={confirmApprove}
                title={techApproved ? "Unapprove timesheet" : "Approve timesheet"}
                body={
                    techApproved
                        ? `Unapprove ${techName ?? "this technician"}'s week of ${formatWeekRange(weekStart)}? The week will be open for edits again.${techWeek?.qb_sync_status !== "not_synced" ? " Its time entries will be deleted from QuickBooks." : ""}`
                        : (
                            <>
                                Approve {techName ?? "this technician"}'s week of {formatWeekRange(weekStart)}? Approved weeks are locked.
                                {weekInProgress && (
                                    <p className="mt-3 rounded-md bg-warning-bg px-3 py-2 text-warning-text">
                                        This week isn't over yet. {techName ?? "The technician"} won't be able to start a shift or clock into visits for the rest of the week unless it's unapproved.
                                    </p>
                                )}
                            </>
                        )
                }
                confirmLabel={techApproved ? "Unapprove" : "Approve"}
                tone={techApproved ? "destructive" : "primary"}
                pending={approving || unapproving}
                onConfirm={() => techParam && handleApproval(techParam, !techApproved)}
                onCancel={() => setConfirmApprove(false)}
            />

            <div className={`grid xl:grid-cols-8 sm:grid-cols-4 grid-cols-2 gap-3 mb-4`}>
				{stats.map((card) => (
					<div key={card.label} className="p-4 bg-base border border-border-subtle rounded-lg">
						<p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-1">
							{card.label}
						</p>
						<p className="text-xl font-bold text-text-primary tabular-nums">{card.value}</p>
						{"hint" in card && card.hint && (
							<p className="text-xs text-text-muted mt-0.5">{card.hint}</p>
						)}
					</div>
				))}
			</div>

            <PageControls
                className="mb-4"
                left={
                    <SearchBar
                        key={isSummaryView ? "summary-search" : "detail-search"}
                        paramKey="search"
                        placeholder={
                            isSummaryView ? "Search by technician..." : "Search by date..."
                        }
                        onValueChange={setSearchInput}
                        onSubmit={addTerm}
                    />
                }
                middle={
                    <div className="relative flex items-center gap-1">
                        <button
                            className="p-2 border border-border-subtle rounded-md bg-surface"
                            onClick={() => setWeek(addDays(weekStart, -7))}
                            aria-label="Previous week"
                        >
                            <ChevronLeft size={14} />
                        </button>
                        <button
                            className="px-3 py-1.5 border border-border-subtle rounded-md text-sm tabular-nums bg-surface"
                            onClick={() => pickerRef.current?.showPicker()}
                        >
                            {formatWeekRange(weekStart)}
                        </button>
                        <input
                            ref={pickerRef}
                            type="date"
                            className="sr-only"
                            tabIndex={-1}
                            aria-hidden
                            value={weekKey}
                            onChange={(e) => e.target.value && setWeek(new Date(`${e.target.value}T00:00`))}
                        />
                        <button
                            className="p-2 border border-border-subtle rounded-md bg-surface"
                            onClick={() => setWeek(addDays(weekStart, 7))}
                            aria-label="Next week"
                        >
                            <ChevronRight size={14} />
                        </button>
                    </div>
                }
                right={
                    <>
                        <ExportExcelButton
                            onExport={() =>
                                exportReport({
                                    filename: datedFilename("timesheets-report"),
                                    sheetName: "Timesheets",
                                    columns: visibleColumns.filter((c) => c.key !== "timeSplit"),
                                    rows,
                                })
                            }
                            disabled={rows.length === 0}
                        />
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
                resultCount={rows.length}
                onClearAll={clearAllFilters}
            />

            <Card
                title="Technician Timesheet"
                headerAction={(
                    <div className="flex flex-wrap gap-4 text-xs text-text-muted">
                        {(isSummaryView
                            ? Object.entries(SPLIT_COLORS)
                            : Object.values(SEG_STYLE).map((s) => [s.label, s.className])
                        ).map(([label, className]) => (
                            <span key={label} className="inline-flex items-center gap-1.5">
                                <span className={`size-2.5 rounded-sm ${className}`} />
                                {label}
                            </span>
                        ))}
                    </div>
                )}
                className="shadow-sm border border-border-subtle bg-base rounded-lg overflow-x-auto text-left"
            >
				{showEmpty ? (
					<div className="text-center py-16">
						<Clock size={48} className="mx-auto text-text-faint mb-3" />
						<h3 className="text-text-tertiary text-lg font-medium mb-2">
							No shifts found
						</h3>
						<p className="text-text-muted text-sm">
							{hasActiveFilters
								? "Try adjusting your filters"
								: isSummaryView
									? "Time is recorded when technicians start and end a shift"
									: `No completed shifts recorded for ${techName ?? "this technician"}`}
						</p>
					</div>
				) : (
                    <AdaptableTable
                        data={rows}
                        loadListener={isLoading}
                        errListener={error}
                        columnVisibility={columnVisibility}
                        onRowClick={
                            isSummaryView
                                ? (row) => handleTechClick(row.id as string)
                                : undefined
                        }
                        cellRenderers={{
                            date: (row) => (
                                <span className="inline-flex items-center gap-2">
                                    {row.date as string}
                                    {!!row._overnight && (
                                        <span className="inline-flex items-center gap-1 text-[11px] bg-surface-raised border border-border-subtle rounded-full px-2 py-0.5 text-text-secondary">
                                            <Moon size={11} /> Overnight
                                        </span>
                                    )}
                                </span>
                            ),
                            status: (row) => (
                                <span className={row.status === "Approved" ? "text-success" : "text-text-muted"}>
                                    {row.status as string}
                                </span>
                            ),
                            qbSync: (row) => (
                                <span className={`flex justify-end ${row.qbSync === "synced" ? "text-success" : row.qbSync === "failed" ? "text-red-500" : "text-text-muted"}`}>
                                    {row.qbSync === "synced" ? <Check/> : row.qbSync === "failed" ? <X/> : row.qbSync === "not_synced" ? "Pending" : "—"}
                                </span>
                            ),
                            timeSplit: (row) => (
                                <TimeSplitBar
                                    segs={[
                                        {label: "Jobs", hours: row._visitHours as number, className: SPLIT_COLORS.Jobs},
                                        {label: "Driving", hours: row._driveHours as number, className: SPLIT_COLORS.Driving},
                                        {label: "Breaks", hours: row._breakHours as number, className: SPLIT_COLORS.Breaks},
                                        {label: "Unassigned", hours: Math.max(0, (row._grossHours as number) - (row._visitHours as number) - (row._driveHours as number) - (row._breakHours as number)), className: SPLIT_COLORS.Unassigned},
                                    ]}
                                />
                            ),
                        }}
                        renderExpanded={isSummaryView
                            ? undefined
                            : (row) => <SegmentTable segments={row._segments as Segment[]} tz={tz} />
                        }
                        renderSubRow={isSummaryView ? undefined : (row) => <Timeline segments={row._segments as Segment[]} axis={axis} tz={tz} />}
                        columnAlign={{
                            qbSync: "right"
                        }}
                    />
                    
				)}
            </Card>
        </div>
    )
}