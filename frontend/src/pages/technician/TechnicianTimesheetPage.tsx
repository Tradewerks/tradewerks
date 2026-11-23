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
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

const pctOf = (t: TFunction, h: number, total: number) =>
    t("timesheet.pctOf", { pct: total > 0 ? Math.round((h / total) * 100) : 0 });

// The server words segments in English; job segments are data and stay as sent
const segText = (t: TFunction, s: Segment): { label: string; sub: string } => {
    const tr = t as unknown as (key: string, opts?: Record<string, unknown>) => string;
    if (s.type === "unassigned") return { label: t("timesheet.segNone"), sub: "" };
    if (s.type === "drive")
        return { label: s.job_number ? t("timesheet.driveTo", { job: s.job_number }) : t("timesheet.driveBack"), sub: "" };
    if (s.type === "break")
        return {
            label: tr(`shiftEdit.reason.${s.label}`, { defaultValue: s.label }),
            sub: t(s.paid ? "shiftEdit.paid" : "shiftEdit.unpaid"),
        };
    return s;
};

interface StatCard {
    label: string;
    value: string;
    hint?: string;
}

type Shift = TechWeekDetails["days"][number];

const spanHours = (s: { start: string; end: string }) =>
        (new Date(s.end).getTime() - new Date(s.start).getTime()) / 3_600_000;

const SEG_STYLE: Record<SegType, string> = {
    job: "bg-primary",
    drive: "bg-amber-500",
    break: "bg-slate-600",
    unassigned: "bg-border-strong",
};

const SEG_TYPES = Object.keys(SEG_STYLE) as SegType[];

const sumType = (segs: Segment[], t: SegType) =>
    segs.filter((s) => s.type === t).reduce((h, s) => h + spanHours(s), 0);

const splitOf = (segs: Segment[]) =>
    SEG_TYPES.map((type) => ({ type, hours: sumType(segs, type), className: SEG_STYLE[type] }));

const dayKey = (d: Date | string, tz?: string) => new Date(d).toLocaleDateString("en-CA", { timeZone: tz });

function TimeSplitBar({ segs, className = "h-3.5" }: { segs: { type: SegType; hours: number; className: string }[]; className?: string }) {
    const { t } = useTranslation();
    const total = segs.reduce((s, x) => s + x.hours, 0);
    if (!total) return null;

    return (
        <div
            className={`flex gap-0.5 w-full rounded overflow-hidden ${className}`}
            title={segs.map((s) => `${t(`timesheet.seg.${s.type}`)} ${fmtHours(s.hours)}`).join(" · ")}
        >
            {segs.filter((s) => s.hours > 0).map((s) => (
                <span key={s.type} className={s.className} style={{ width: `${(s.hours / total) * 100}%` }} />
            ))}
        </div>
    )
}

function DayLabel({ date, tz, muted }: { date: Date | string; tz?: string; muted?: boolean }) {
    const { i18n } = useTranslation();
    const d = new Date(date);
    return (
        <div className="w-11 shrink-0">
            <p className="text-xs font-medium text-text-muted">{d.toLocaleDateString(i18n.language, { weekday: "short", timeZone: tz })}</p>
            <p className={`text-lg font-bold ${muted ? "text-text-muted" : "text-text-primary"}`}>
                {d.toLocaleDateString(i18n.language, { day: "numeric", timeZone: tz })}
            </p>
        </div>
    );
}

function ShiftRow({ shift, tz, canEdit, setEditShiftId, setReportShiftId }: { shift: Shift; tz: string; canEdit: boolean; setEditShiftId: (id: string) => void; setReportShiftId: (id: string) => void }) {
    const { t } = useTranslation();
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
                            {formatTime(shift.start, tz)} - {shift.end ? formatTime(shift.end, tz) : t("timesheet.now")}
                        </p>
                        <p className="flex items-center gap-1.5 text-xs text-text-muted">
                            {t("timesheet.visits", { count: visits })}
                            {overnight && <><Moon size={11} /> {t("timesheet.overnight")}</>}
                            {pending && (
                                <span className="rounded-full bg-warning-bg px-2 py-0.5 font-medium text-warning-text">
                                    {t("timesheet.correctionPending")}
                                </span>
                            )}
                        </p>
                    </div>
                    <div className="text-right tabular-nums">
                        <p className="font-bold text-text-primary">{shift.end ? fmtHours(shift.payableHours) : "—"}</p>
                        <p className="text-xs text-text-muted">{t("timesheet.payableShort")}</p>
                    </div>
                    <ChevronRight size={18} className="shrink-0 text-text-muted transition-transform group-open:rotate-90" />
                </div>
                <div className="ml-14 mr-7">
                    <TimeSplitBar segs={splitOf(shift.segments)} className="h-1.5" />
                </div>
            </summary>
            <ol className="px-4 pb-3">
                {shift.segments.map((s, i) => {
                    const { label, sub } = segText(t, s);
                    return (
                    <li key={i} className="flex items-start gap-3 py-2">
                        <span className="w-16 shrink-0 pt-0.5 text-right text-xs tabular-nums text-text-muted">
                            {formatTime(s.start, tz)}
                        </span>
                        <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${SEG_STYLE[s.type]}`} />
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-text-primary">{label}</p>
                            {sub && <p className="text-xs text-text-muted">{sub}</p>}
                        </div>
                        <span className="text-sm font-medium tabular-nums text-text-secondary">{fmtHours(spanHours(s))}</span>
                    </li>
                    );
                })}
            </ol>
            {last && (
                <p className={`px-4 pb-3 text-sm ${last.status === "accepted" ? "text-success-text" : "text-error-text"}`}>
                    {last.status === "accepted"
                        ? t("timesheet.correctionAccepted")
                        : last.review_note
                          ? t("timesheet.correctionRejectedNote", { note: last.review_note })
                          : t("timesheet.correctionRejected")}
                </p>
            )}
            {canEdit && shift.end && (
                <div className="px-4 pb-4">
                    <button
                        type="button"
                        onClick={() => setEditShiftId(shift.shiftId)}
                        className="flex w-full min-h-11 items-center justify-center gap-2 border border-border-subtle rounded-md bg-surface text-sm font-medium text-text-secondary hover:bg-surface-raised hover:text-text-primary transition-colors"
                    >
                        <Pencil size={14} /> {t("timesheet.editTimes")}
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
                        <Timer size={14} /> {t(pending ? "timesheet.updateSuggestion" : "timesheet.reportIssue")}
                    </button>
                </div>
            )}
        </details>
    );
}

export default function TechnicianTimesheet () {
    const { user } = useAuthStore();
    const { t } = useTranslation();
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
                { label: t("timesheet.payable"), value: fmtHours(payableHours), hint: t("timesheet.shiftCount", { count: shifts.length }) },
                { label: t("timesheet.shiftTime"), value: fmtHours(grossHours), hint: t("timesheet.inclBreaks") },
                { label: t("timesheet.onJobs"), value: fmtHours(jobHours), hint: pctOf(t, jobHours, grossHours) },
                { label: t("timesheet.driving"), value: fmtHours(driveHours), hint: pctOf(t, driveHours, grossHours) },
            ] as StatCard[],
            split,
        };
    }, [week, tz, weekKey, t]);

    return (
        <TechPage>
            <PageHeader title={t("timesheet.title")}>
                {approved ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-success-bg px-3 py-1 text-sm font-medium text-success-text">
                        <Lock size={14} /> {t("timesheet.approved")}
                    </span>
                ) : (
                    <span className="inline-flex items-center rounded-full bg-warning-bg px-3 py-1 text-sm font-medium text-warning-text">
                        {t("timesheet.open")}
                    </span>
                )}
            </PageHeader>

            <div className="relative flex items-center justify-between gap-1 mb-4">
                <button
                    className="p-3 border border-border-subtle rounded-md bg-surface"
                    onClick={() => setWeek(addDays(weekStart, -7))}
                    aria-label={t("timesheet.prevWeek")}
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
                    aria-label={t("timesheet.nextWeek")}
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
                title={t("timesheet.shifts")}
                headerAction={(
                    <div className="flex flex-wrap gap-3 text-xs text-text-muted">
                        {SEG_TYPES.map((type) => (
                            <span key={type} className="inline-flex items-center gap-1.5">
                                <span className={`size-2.5 rounded-sm ${SEG_STYLE[type]}`} />
                                {t(`timesheet.seg.${type}`)}
                            </span>
                        ))}
                    </div>
                )}
                className="shadow-sm border border-border-subtle bg-base rounded-lg text-left"
            >
                {isLoading ? (
                    <p className="py-16 text-center text-sm text-text-muted">{t("common.loading")}</p>
                ) : error ? (
                    <p className="py-16 text-center text-sm text-text-muted">{t("timesheet.loadFailed")}</p>
                ) : !week?.days.length ? (
                    <div className="text-center py-16">
                        <Clock size={48} className="mx-auto text-text-faint mb-3" />
                        <h3 className="text-text-tertiary text-lg font-medium mb-2">{t("timesheet.noShifts")}</h3>
                        <p className="text-text-muted text-sm">{t("timesheet.noShiftsHint")}</p>
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
                                    <p className="text-sm text-text-muted">{t("timesheet.noShift")}</p>
                                </div>
                            ),
                        )}
                    </>
                )}
            </Card>

            <p className="mt-4 text-sm text-text-secondary">
                {t(approved ? "timesheet.lockedNote" : "timesheet.openNote")}
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
