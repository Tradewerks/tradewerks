import { useTechnicianWeekQuery } from "../../hooks/useTimesheets"
import { useMemo, useRef, useState } from "react";
import PageHeader from "../../components/ui/PageHeader";
import { useLocation, useNavigate } from "react-router-dom";
import { fmtHours, formatTime, FALLBACK_TIMEZONE } from "../../util/util";
import { ChevronLeft, ChevronRight, Clock, Lock, Moon, Pencil, Timer, } from "lucide-react";
import { addDays, formatWeekRange, startOfWeek } from "../../util/util";
import Card from "../../components/ui/Card";
import type { Segment, SegType, TechWeekDetails } from "../../types/timesheets";
import { useAuthStore } from "../../auth/authStore";
import TechPage from "../../components/technician/TechPage";
import { usePermission } from "../../hooks/usePermission";
import EditShiftModal from "../../components/timesheets/EditShiftModal";

const pctOf = (h: number, total: number) =>
    `${total > 0 ? Math.round((h / total) * 100) : 0}% of shift time`;

interface StatCard {
    label: string;
    value: string;
    hint?: string;
}

type Shift = TechWeekDetails["days"][number];

const spanHours = (s: { start: string; end: string }) =>
        (new Date(s.end).getTime() - new Date(s.start).getTime()) / 3_600_000;

const SEG_STYLE: Record<SegType, { label: string; className: string }> = {
    job: { label: "Jobs", className: "bg-primary" },
    drive: { label: "Driving", className: "bg-amber-500" },
    break: { label: "Breaks", className: "bg-slate-600" },
    unassigned: { label: "Unassigned", className: "bg-border-strong" },
};

const SEG_TYPES = Object.keys(SEG_STYLE) as SegType[];

const sumType = (segs: Segment[], t: SegType) =>
    segs.filter((s) => s.type === t).reduce((h, s) => h + spanHours(s), 0);

const splitOf = (segs: Segment[]) =>
    SEG_TYPES.map((t) => ({ label: SEG_STYLE[t].label, hours: sumType(segs, t), className: SEG_STYLE[t].className }));

const dayKey = (d: Date | string, tz?: string) => new Date(d).toLocaleDateString("en-CA", { timeZone: tz });

function TimeSplitBar({ segs, className = "h-3.5" }: { segs: { label: string; hours: number; className: string }[]; className?: string }) {
    const total = segs.reduce((s, x) => s + x.hours, 0);
    if (!total) return null;

    return (
        <div
            className={`flex gap-0.5 w-full rounded overflow-hidden ${className}`}
            title={segs.map((s) => `${s.label} ${fmtHours(s.hours)}`).join(" · ")}
        >
            {segs.filter((s) => s.hours > 0).map((s) => (
                <span key={s.label} className={s.className} style={{ width: `${(s.hours / total) * 100}%` }} />
            ))}
        </div>
    )
}

function DayLabel({ date, tz, muted }: { date: Date | string; tz?: string; muted?: boolean }) {
    const d = new Date(date);
    return (
        <div className="w-11 shrink-0">
            <p className="text-xs font-medium text-text-muted">{d.toLocaleDateString("en-US", { weekday: "short", timeZone: tz })}</p>
            <p className={`text-lg font-bold ${muted ? "text-text-muted" : "text-text-primary"}`}>
                {d.toLocaleDateString("en-US", { day: "numeric", timeZone: tz })}
            </p>
        </div>
    );
}

function ShiftRow({ shift, tz, canEdit, setEditShiftId, setReportShiftId }: { shift: Shift; tz: string; canEdit: boolean; setEditShiftId: (id: string) => void; setReportShiftId: (id: string) => void }) {
    const visits = new Set(shift.segments.filter((s) => s.type === "job").map((s) => s.label)).size;
    const overnight = !!shift.end && dayKey(shift.end, tz) !== dayKey(shift.start, tz);
    const pending = !!shift.pendingCorrection;
    const last = !pending && shift.lastCorrection;

    return (
        <details className="group border-b border-border-subtle last:border-b-0">
            <summary className="flex flex-col gap-2 px-4 py-3.5 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                <div className="flex items-center gap-3">
                    <DayLabel date={shift.start} tz={tz} />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-text-primary">
                            {formatTime(shift.start, tz)} - {shift.end ? formatTime(shift.end, tz) : "now"}
                        </p>
                        <p className="flex items-center gap-1.5 text-xs text-text-muted">
                            {visits} {visits === 1 ? "visit" : "visits"}
                            {overnight && <><Moon size={11} /> Overnight</>}
                            {pending && (
                                <span className="rounded-full bg-warning-bg px-2 py-0.5 font-medium text-warning-text">
                                    Correction pending
                                </span>
                            )}
                        </p>
                    </div>
                    <div className="text-right tabular-nums">
                        <p className="font-bold text-text-primary">{shift.end ? fmtHours(shift.payableHours) : "—"}</p>
                        <p className="text-xs text-text-muted">payable</p>
                    </div>
                    <ChevronRight size={18} className="shrink-0 text-text-muted transition-transform group-open:rotate-90" />
                </div>
                <div className="ml-14 mr-7">
                    <TimeSplitBar segs={splitOf(shift.segments)} className="h-1.5" />
                </div>
            </summary>
            <ol className="px-4 pb-3">
                {shift.segments.map((s, i) => (
                    <li key={i} className="flex items-start gap-3 py-2">
                        <span className="w-16 shrink-0 pt-0.5 text-right text-xs tabular-nums text-text-muted">
                            {formatTime(s.start, tz)}
                        </span>
                        <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${SEG_STYLE[s.type].className}`} />
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-text-primary">{s.label}</p>
                            {s.sub && <p className="text-xs text-text-muted">{s.sub}</p>}
                        </div>
                        <span className="text-sm font-medium tabular-nums text-text-secondary">{fmtHours(spanHours(s))}</span>
                    </li>
                ))}
            </ol>
            {last && (
                <p className={`px-4 pb-3 text-sm ${last.status === "accepted" ? "text-success-text" : "text-error-text"}`}>
                    {last.status === "accepted"
                        ? "Correction accepted"
                        : `Correction rejected${last.review_note ? `: ${last.review_note}` : ""}`}
                </p>
            )}
            {canEdit && shift.end && (
                <div className="px-4 pb-4">
                    <button
                        type="button"
                        onClick={() => setEditShiftId(shift.shiftId)}
                        className="flex w-full min-h-11 items-center justify-center gap-2 border border-border-subtle rounded-md bg-surface text-sm font-medium text-text-secondary hover:bg-surface-raised hover:text-text-primary transition-colors"
                    >
                        <Pencil size={14} /> Edit times
                    </button>
                </div>
            )}
            {!canEdit && shift.end && (
                <div className="px-4 pb-4">
                    <button
                        type="button"
                        onClick={() => setReportShiftId(shift.shiftId)}
                        className="flex w-full min-h-11 items-center justify-center gap-2 border border-border-subtle rounded-md bg-surface text-sm font-medium text-text-secondary hover:bg-error/50 hover:text-text-primary transition-colors"
                    >
                        <Timer size={14} /> {pending ? "Update suggestion" : "Report issue"}
                    </button>
                </div>
            )}
        </details>
    );
}

export default function TechnicianTimesheet () {
    const { user } = useAuthStore();
    const tz = user?.orgTimezone ?? FALLBACK_TIMEZONE;
    const navigate = useNavigate();
    const location = useLocation();

    const weekParam = new URLSearchParams(location.search).get("week");
    const parsedWeek = new Date(`${weekParam}T00:00`);
    const weekStart = startOfWeek(Number.isNaN(parsedWeek.getTime()) ? new Date() : parsedWeek);
    const weekKey = weekStart.toLocaleDateString("en-CA");
    const isCurrentWeek = addDays(weekStart, 7) > new Date();
    const pickerRef = useRef<HTMLInputElement>(null);    
    
    const setWeek = (day: Date) => {
        navigate(`/technician/timesheet?week=${startOfWeek(day).toLocaleDateString("en-CA")}`);
    };
    
    const { data: week, isLoading, error } = useTechnicianWeekQuery(user?.userId ?? "", weekKey);
    const approved = !!week?.approvedAt;
    const EDIT_TIMESHEET = usePermission("edit_own_timesheet");
    const canEditTimes = EDIT_TIMESHEET && !approved;
    const [editShiftId, setEditShiftId] = useState<string | null>(null);
    const editDay = week?.days.find((d) => d.shiftId === editShiftId);
    const [reportShiftId, setReportShiftId] = useState<string | null>(null);
    const reportDay = week?.days.find((d) => d.shiftId === reportShiftId);
    
    const { days, stats, split } = useMemo(() => {
        const shifts = week?.days ?? [];
        const allSegs = shifts.flatMap((d) => d.segments);
        const split = splitOf(allSegs);
        const grossHours = split.reduce((s, x) => s + x.hours, 0);
        const jobHours = sumType(allSegs, "job");
        const driveHours = sumType(allSegs, "drive");
        const payableHours = shifts.reduce((s, d) => s + d.payableHours, 0);

        return {
            days: Array.from({ length: 7 }, (_, i) => {
                const date = addDays(new Date(`${weekKey}T00:00`), i);
                return { date, shifts: shifts.filter((s) => dayKey(s.start, tz) === dayKey(date)) };
            }),
            stats: [
                { label: "Payable", value: fmtHours(payableHours), hint: `${shifts.length} ${shifts.length === 1 ? "shift" : "shifts"}` },
                { label: "Shift Time", value: fmtHours(grossHours), hint: "including breaks" },
                { label: "On Jobs", value: fmtHours(jobHours), hint: pctOf(jobHours, grossHours) },
                { label: "Driving", value: fmtHours(driveHours), hint: pctOf(driveHours, grossHours) },
            ] as StatCard[],
            split,
        };
    }, [week, tz, weekKey]);

    return (
        <TechPage>
            <PageHeader title="My Time">
                {approved ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-success-bg px-3 py-1 text-sm font-medium text-success-text">
                        <Lock size={14} /> Approved
                    </span>
                ) : (
                    <span className="inline-flex items-center rounded-full bg-warning-bg px-3 py-1 text-sm font-medium text-warning-text">
                        Open
                    </span>
                )}
            </PageHeader>

            <div className="relative flex items-center justify-between gap-1 mb-4">
                <button
                    className="p-3 border border-border-subtle rounded-md bg-surface"
                    onClick={() => setWeek(addDays(weekStart, -7))}
                    aria-label="Previous week"
                >
                    <ChevronLeft size={16} />
                </button>
                <button
                    className="flex-1 py-2.5 border border-border-subtle rounded-md text-sm font-medium tabular-nums bg-surface"
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
                    className="p-3 border border-border-subtle rounded-md bg-surface disabled:opacity-40"
                    onClick={() => setWeek(addDays(weekStart, 7))}
                    disabled={isCurrentWeek}
                    aria-label="Next week"
                >
                    <ChevronRight size={16} />
                </button>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4">
                {stats.map((card) => (
                    <div key={card.label} className="p-4 bg-base border border-border-subtle rounded-lg">
                        <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-1">
                            {card.label}
                        </p>
                        <p className="text-xl font-bold text-text-primary tabular-nums">{card.value}</p>
                        {card.hint && <p className="text-xs text-text-muted mt-0.5">{card.hint}</p>}
                    </div>
                ))}
            </div>

            <Card
                title="Shifts"
                headerAction={(
                    <div className="flex flex-wrap gap-3 text-xs text-text-muted">
                        {Object.values(SEG_STYLE).map(({ label, className }) => (
                            <span key={label} className="inline-flex items-center gap-1.5">
                                <span className={`size-2.5 rounded-sm ${className}`} />
                                {label}
                            </span>
                        ))}
                    </div>
                )}
                className="shadow-sm border border-border-subtle bg-base rounded-lg text-left"
            >
                {isLoading ? (
                    <p className="py-16 text-center text-sm text-text-muted">Loading…</p>
                ) : error ? (
                    <p className="py-16 text-center text-sm text-text-muted">Couldn't load your timesheet</p>
                ) : !week?.days.length ? (
                    <div className="text-center py-16">
                        <Clock size={48} className="mx-auto text-text-faint mb-3" />
                        <h3 className="text-text-tertiary text-lg font-medium mb-2">No shifts this week</h3>
                        <p className="text-text-muted text-sm">Time is recorded when you start and end a shift</p>
                    </div>
                ) : (
                    <>
                        <div className="px-4 py-3 border-b border-border-subtle">
                            <TimeSplitBar segs={split} />
                        </div>
                        {days.map(({ date, shifts }) =>
                            shifts.length ? (
                                shifts.map((s) => <ShiftRow key={s.shiftId} shift={s} tz={tz} canEdit={canEditTimes} setEditShiftId={setEditShiftId} setReportShiftId={setReportShiftId} />)
                            ) : (
                                <div key={date.toISOString()} className="flex items-center gap-3 px-4 py-3.5 border-b border-border-subtle last:border-b-0">
                                    <DayLabel date={date} muted />
                                    <p className="text-sm text-text-muted">No shift</p>
                                </div>
                            ),
                        )}
                    </>
                )}
            </Card>

            <p className="mt-4 text-sm text-text-secondary">
                {approved
                    ? "This week is approved and locked. If something looks wrong, contact your dispatcher."
                    : "Hours can still change until dispatch approves the week. If something looks wrong, contact your dispatcher."}
            </p>

            {editDay && <EditShiftModal day={editDay} tz={tz} onClose={() => setEditShiftId(null)} />}
            {reportDay && (
                <EditShiftModal
                    day={reportDay}
                    tz={tz}
                    onClose={() => setReportShiftId(null)}
                    mode="suggest"
                    initial={reportDay.pendingCorrection?.proposed}
                />
            )}
        </TechPage>
    )
}
