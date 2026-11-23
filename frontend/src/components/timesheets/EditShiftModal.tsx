import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import i18n from "../../i18n";
import FullPopup from "../ui/FullPopup";
import { useToast } from "../ui/useToast";
import {
	useAcceptCorrectionMutation,
	useEditShiftMutation,
	useRejectCorrectionMutation,
	useReportShiftIssueMutation,
} from "../../hooks/useTimesheets";
import {
	atShiftTime,
	errorMessage,
	fmtHours,
	formatDate,
	formatTime,
	toLocalInputValue,
} from "../../util/util";
import type { EditShiftInput, ShiftBreak, ShiftCorrection, TechWeekDetails } from "../../types/timesheets";

type Day = TechWeekDetails["days"][number];
type Mode = "edit" | "suggest" | "review";
type Reason = ShiftBreak["reason"];
type Row = {
	kind: "shift" | "break" | "entry";
	id: string;
	label: string;
	sub: string;
	unpaid: boolean;
	start: string;
	end: string;
	origStart: string;
	origEnd: string;
	reason?: Reason;
	isNew?: boolean;
	deleted?: boolean;
};

const REASONS: Reason[] = ["Lunch", "Rest", "EquipmentIssue", "Other"];
// Mirrors the backend's PAID_BREAK_REASONS.
const PAID_REASONS = new Set<Reason>(["Rest", "EquipmentIssue"]);
const breakInfo = (reason: Reason, paid = PAID_REASONS.has(reason)) => ({
	reason,
	label: i18n.t(`shiftEdit.reason.${reason}`),
	sub: i18n.t(paid ? "shiftEdit.paid" : "shiftEdit.unpaid"),
	unpaid: !paid,
});
let newBreakSeq = 0;
const newBreak = (reason: Reason, start: string, end: string): Row => ({
	kind: "break",
	id: `new-${++newBreakSeq}`,
	...breakInfo(reason),
	start,
	end,
	origStart: "",
	origEnd: "",
	isNew: true,
});

const row = (r: Omit<Row, "origStart" | "origEnd">): Row => ({ ...r, origStart: r.start, origEnd: r.end });
const toTime = (iso: string | null) => toLocalInputValue(iso).slice(11);

const toRows = (day: Day): Row[] => [
	row({
		kind: "shift",
		id: day.shiftId,
		label: i18n.t("shiftEdit.shift"),
		sub: i18n.t("shiftEdit.shiftSub"),
		unpaid: false,
		start: toTime(day.start),
		end: toTime(day.end),
	}),
	...day.breaks.map((b) =>
		row({
			kind: "break",
			id: b.id,
			...breakInfo(b.reason, b.is_paid),
			start: toTime(b.started_at),
			end: toTime(b.ended_at),
		})
	),
	...day.entries
		.filter((e) => e.clocked_out_at)
		.map((e) =>
			row({
				kind: "entry",
				id: e.id,
				label: `${e.visit.job.job_number} · ${e.visit.job.client.name}`,
				sub: e.visit.name ?? e.visit.job.name,
				unpaid: false,
				start: toTime(e.clocked_in_at),
				end: toTime(e.clocked_out_at),
			})
		),
];

const proposedFor = (p: EditShiftInput, r: Row): [string | undefined, string | undefined] => {
	if (r.kind === "shift") return [p.started_at, p.ended_at];
	if (r.kind === "break") {
		const b = p.breaks?.find((x) => x.id === r.id);
		return [b?.started_at, b?.ended_at];
	}
	const e = p.entries?.find((x) => x.id === r.id);
	return [e?.clocked_in_at, e?.clocked_out_at];
};

const withProposed = (rows: Row[], p?: EditShiftInput): Row[] =>
	!p
		? rows
		: [
				...rows.map((r) => {
					const [s, e] = proposedFor(p, r);
					return {
						...r,
						start: s ? toTime(s) : r.start,
						end: e ? toTime(e) : r.end,
						deleted: p.delete_break_ids?.includes(r.id),
					};
				}),
				...(p.breaks ?? [])
					.filter((b) => !b.id)
					.map((b) => newBreak(b.reason ?? "Other", toTime(b.started_at), toTime(b.ended_at))),
			];

const hrs = (start: Date, end: Date) => Math.max(0, (end.getTime() - start.getTime()) / 3_600_000) || 0;

const payableOf = (rows: Row[], date: string, pick: (r: Row) => [string, string]) => {
	const anchor = pick(rows[0])[0];
	const span = (r: Row) => {
		const [s, e] = pick(r);
		return hrs(atShiftTime(date, anchor, s), atShiftTime(date, anchor, e));
	};
	return rows.reduce((sum, r) => (r.kind === "shift" ? sum + span(r) : r.unpaid ? sum - span(r) : sum), 0);
};

interface EditShiftModalProps {
	day: Day;
	tz: string;
	onClose: () => void;
	initial?: EditShiftInput;
	mode?: Mode;
	correction?: ShiftCorrection;
}

export default function EditShiftModal({ day, tz, onClose, initial, mode = "edit", correction }: EditShiftModalProps) {
	const toast = useToast();
	const { t } = useTranslation();
	const [rows, setRows] = useState(() => withProposed(toRows(day), initial ?? correction?.proposed));
	const [message, setMessage] = useState("");
	const date = toLocalInputValue(day.start).slice(0, 10);
	const anchor = rows[0].start;
	const at = (time: string) => atShiftTime(date, anchor, time);
	const iso = (time: string) => at(time).toISOString();
	const { mutateAsync: editShift, isPending: isEditPending } = useEditShiftMutation();
	const { mutateAsync: reportIssue, isPending: isReportPending } = useReportShiftIssueMutation();
	const { mutateAsync: acceptCorrection, isPending: isAcceptPending } = useAcceptCorrectionMutation();
	const { mutateAsync: rejectCorrection, isPending: isRejectPending } = useRejectCorrectionMutation();
	const isPending = isEditPending || isReportPending || isAcceptPending || isRejectPending;

	const live = rows.filter((r) => !r.deleted);
	const changed = rows.filter((r) => r.deleted || r.start !== r.origStart || r.end !== r.origEnd).length;
	const gross = hrs(at(rows[0].start), at(rows[0].end));
	const payable = payableOf(live, date, (r) => [r.start, r.end]);
	const unpaidBreaks = gross - payable;
	const delta =
		payable -
		payableOf(
			rows.filter((r) => !r.isNew),
			date,
			(r) => [r.origStart, r.origEnd]
		);
	const changes = t("shiftEdit.changes", { count: changed });
	const note = message.trim() || undefined;

	const setTime = (id: string, field: "start" | "end", value: string) =>
		setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
	const setReason = (id: string, reason: Reason) =>
		setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...breakInfo(reason) } : r)));
	// A new break just disappears; an existing one is kept, flagged, so it can be sent as a delete.
	const removeBreak = (id: string) =>
		setRows((prev) => prev.flatMap((r) => (r.id !== id ? [r] : r.isNew ? [] : [{ ...r, deleted: true }])));
	const addBreak = () => setRows((prev) => [...prev, newBreak("Lunch", "12:00", "12:30")]);

	const toInput = (rows: Row[]) => {
		const data: EditShiftInput = {
			breaks: [],
			entries: [],
			delete_break_ids: rows.filter((r) => r.deleted).map((r) => r.id),
		};
		for (const r of rows.filter((r) => !r.deleted)) {
			if (r.kind === "shift") {
				data.started_at = iso(r.start);
				data.ended_at = iso(r.end);
			} else if (r.kind === "break") {
				data.breaks!.push({
					...(r.isNew ? { reason: r.reason } : { id: r.id }),
					started_at: iso(r.start),
					ended_at: iso(r.end),
				});
			} else {
				data.entries!.push({ id: r.id, clocked_in_at: iso(r.start), clocked_out_at: iso(r.end) });
			}
		}
		return data;
	};

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault();
		const data = toInput(rows);
		try {
			const breaks = [...(data.breaks ?? [])].sort((a, b) => a.started_at.localeCompare(b.started_at));
			if (breaks.some((b, i) => i > 0 && breaks[i - 1].ended_at > b.started_at)) {
				toast.error(t("shiftEdit.overlap"));
				return;
			}
			if (mode === "edit") await editShift({ shiftId: day.shiftId, data });
			else if (mode === "suggest")
				await reportIssue({ shiftId: day.shiftId, message, proposed: changed ? data : undefined });
			else await acceptCorrection({ id: correction!.id, note, proposed: data });
			toast.success(t(`shiftEdit.done.${mode}`));
			onClose();
		} catch (err) {
			toast.error(errorMessage(err, t(`shiftEdit.fail.${mode}`)));
		}
	};

	const handleReject = async () => {
		try {
			await rejectCorrection({ id: correction!.id, note });
			toast.success(t("timesheet.correctionRejected"));
			onClose();
		} catch (err) {
			toast.error(errorMessage(err, t("shiftEdit.rejectFail")));
		}
	};

	const was = (orig: string) => formatTime(atShiftTime(date, rows[0].origStart, orig), tz);
	const isDirty = (r: Row) => r.deleted || r.start !== r.origStart || r.end !== r.origEnd;

	const timeInput = (r: Row, field: "start" | "end") => {
		const orig = field === "start" ? r.origStart : r.origEnd;
		const dirty = r[field] !== orig;
		return (
			<div className="flex flex-col gap-1">
				<label
					className={`flex flex-col px-3 py-1.5 rounded-lg border focus-within:border-primary ${
						dirty ? "border-2 border-primary bg-primary-bg-subtle" : "border-border bg-surface"
					}`}
				>
					<span className={`text-xs ${dirty ? "text-primary-text" : "text-text-muted"}`}>
						{t(`shiftEdit.${field}`)}
					</span>
					<input
						type="time"
						required
						value={r[field]}
						onChange={(e) => setTime(r.id, field, e.target.value)}
						aria-label={t(`shiftEdit.${field}Aria`, { label: r.label })}
						className="w-full p-0 text-base bg-transparent text-text-primary focus:outline-none"
					/>
				</label>
				{dirty && !r.isNew && <span className="pl-3 text-xs text-primary-text">{t("shiftEdit.was")} {was(orig)}</span>}
			</div>
		);
	};

	const rowView = (r: Row) => {
		const hours = (
			<span className="text-[15px] font-semibold tabular-nums">{fmtHours(hrs(at(r.start), at(r.end)))}</span>
		);
		const tag = r.isNew ? t("shiftEdit.added") : r.deleted ? t("shiftEdit.removed") : null;
		const title = (
			<p className={`text-[15px] ${r.kind === "shift" ? "font-semibold" : "font-medium"}`}>
				<span className={r.deleted ? "line-through" : ""}>{r.label}</span>
				{tag && <span className="ml-2 text-xs font-semibold text-primary-text">{tag}</span>}
			</p>
		);
		if (mode === "review")
			return (
				<div
					key={r.id}
					className={`flex items-start gap-3 px-3.5 py-3 border-t border-border first:border-t-0 ${
						isDirty(r) ? "bg-primary-bg-subtle" : ""
					}`}
				>
					<div className="flex-1 min-w-0">
						{title}
						<p className="text-sm tabular-nums">
							<span className={r.start !== r.origStart ? "font-semibold text-primary-text" : ""}>
								{formatTime(at(r.start), tz)}
							</span>
							{" – "}
							<span className={r.end !== r.origEnd ? "font-semibold text-primary-text" : ""}>
								{formatTime(at(r.end), tz)}
							</span>
						</p>
						{isDirty(r) && !tag && (
							<p className="text-[13px] text-text-muted">
								{t("shiftEdit.was")} <s>{was(r.origStart)} – {was(r.origEnd)}</s>
							</p>
						)}
					</div>
					{hours}
				</div>
			);
		return (
			<div key={r.id} className="flex flex-col gap-2">
				<div className="flex items-center gap-3">
					<div className="flex-1 min-w-0">
						{r.isNew ? (
							<select
								aria-label={t("shiftEdit.reasonAria")}
								value={r.reason}
								onChange={(e) => setReason(r.id, e.target.value as Reason)}
								className="py-1 text-base font-medium bg-transparent text-text-primary focus:outline-none"
							>
								{REASONS.map((x) => (
									<option key={x} value={x}>
										{t(`shiftEdit.reason.${x}`)}
									</option>
								))}
							</select>
						) : (
							title
						)}
						<p className="text-[13px] text-text-muted">{r.sub}</p>
					</div>
					{hours}
					{r.kind === "break" && (
						<button
							type="button"
							onClick={() => removeBreak(r.id)}
							aria-label={t("shiftEdit.removeAria", { label: r.label })}
							className="flex items-center justify-center w-11 h-11 -my-2 -mr-3 rounded-full text-text-muted hover:text-error-text hover:bg-error-bg"
						>
							<Trash2 size={18} />
						</button>
					)}
				</div>
				<div className="grid grid-cols-2 gap-2">
					{timeInput(r, "start")}
					{timeInput(r, "end")}
				</div>
			</div>
		);
	};

	const heading = "text-xs font-semibold tracking-wider uppercase text-text-muted";
	const breaks = live.filter((r) => r.kind === "break");
	const entries = rows.filter((r) => r.kind === "entry");

	const content = (
		<form onSubmit={handleSubmit} className="flex flex-col min-h-0">
			<div className="flex justify-center pt-2 sm:hidden">
				<div className="w-9 h-1.5 rounded-full bg-border" />
			</div>
			<div className="flex items-center gap-2 pl-5 pr-2 pt-1 pb-3 sm:pt-3 border-b border-border-subtle">
				<div className="flex-1 min-w-0">
					<h2 className="text-[17px] font-semibold text-text-primary">{t(`shiftEdit.title.${mode}`)}</h2>
					<p className="text-[13px] text-text-muted">
						{formatDate(day.start, tz)}
						{changed > 0 && ` · ${changes}`}
					</p>
				</div>
				<button
					type="button"
					onClick={onClose}
					disabled={isPending}
					aria-label={t("common.close")}
					className="flex items-center justify-center w-11 h-11 rounded-md text-text-secondary hover:bg-surface-raised disabled:opacity-50"
				>
					<X size={20} />
				</button>
			</div>

			<div className="flex flex-col gap-4 px-5 py-4 overflow-y-auto">
				{mode === "review" && (
					<div className="px-3.5 py-3 bg-surface-raised rounded-lg">
						<p className="text-xs text-text-muted">{t("shiftEdit.techMessage")}</p>
						<p className="text-[15px] text-text-primary whitespace-pre-wrap">{correction!.message}</p>
					</div>
				)}

				{mode === "suggest" && (
					<label className="flex flex-col gap-1.5">
						<span className="text-sm font-semibold text-text-secondary">{t("shiftEdit.whatWrong")}</span>
						<textarea
							required
							rows={2}
							maxLength={500}
							value={message}
							onChange={(e) => setMessage(e.target.value)}
							placeholder={t("shiftEdit.whatWrongPlaceholder")}
							className="px-3 py-2.5 text-base bg-surface border border-border rounded-lg text-text-primary resize-none focus:outline-none focus:border-primary"
						/>
						<span className="self-end text-xs text-text-muted tabular-nums">{message.length}/500</span>
					</label>
				)}

				{mode === "review" ? (
					<div className="flex flex-col border border-border rounded-xl overflow-hidden">{rows.map(rowView)}</div>
				) : (
					<>
						<section className="flex flex-col gap-2">
							<h3 className={heading}>{t("shiftEdit.shift")}</h3>
							{rows.filter((r) => r.kind === "shift").map(rowView)}
						</section>
						<section className="flex flex-col gap-2">
							<h3 className={heading}>{t("shiftEdit.breaks")}</h3>
							{breaks.map(rowView)}
							<button
								type="button"
								onClick={addBreak}
								className="flex items-center gap-1.5 self-start py-2 text-sm font-medium text-primary-text"
							>
								<Plus size={16} />
								{t("shiftEdit.addBreak")}
							</button>
						</section>
						{entries.length > 0 && (
							<section className="flex flex-col gap-4">
								<h3 className={`${heading} -mb-2`}>{t("shiftEdit.jobs")}</h3>
								{entries.map(rowView)}
							</section>
						)}
					</>
				)}

				{mode === "review" && (
					<label className="flex flex-col gap-1.5">
						<span className="text-sm font-semibold text-text-secondary">{t("shiftEdit.noteToTech")}</span>
						<textarea
							rows={2}
							maxLength={500}
							value={message}
							onChange={(e) => setMessage(e.target.value)}
							placeholder={t("shiftEdit.notePlaceholder")}
							className="px-3 py-2.5 text-base bg-surface border border-border rounded-lg text-text-primary resize-none focus:outline-none focus:border-primary"
						/>
					</label>
				)}
			</div>

			<div className="flex flex-col gap-2.5 px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-border-subtle">
				<div className="flex items-baseline justify-between gap-3">
					<p className="text-[13px] text-text-muted tabular-nums">
						{t("shiftEdit.totals", { gross: fmtHours(gross), unpaid: fmtHours(unpaidBreaks) })}
					</p>
					<p className="text-[15px] font-semibold text-text-primary tabular-nums">
						{t("shiftEdit.payable", { hours: fmtHours(payable) })}
						{Math.round(delta * 60) !== 0 && (
							<span className={`ml-1.5 text-[13px] ${delta > 0 ? "text-success-text" : "text-warning-text"}`}>
								{delta > 0 ? "+" : "−"}
								{fmtHours(Math.abs(delta))}
							</span>
						)}
					</p>
				</div>
				<div className="grid grid-flow-col auto-cols-fr gap-2.5">
					{mode === "review" && (
						<button
							type="button"
							onClick={handleReject}
							disabled={isPending}
							className="flex items-center justify-center gap-2 h-[50px] text-base font-semibold text-error-text border border-border hover:bg-error-bg rounded-xl transition-colors duration-150 ease-out disabled:opacity-50"
						>
							{isRejectPending && <Loader2 size={16} className="animate-spin" />}
							{t("shiftEdit.reject")}
						</button>
					)}
					<button
						type="submit"
						disabled={isPending || (mode === "suggest" ? !message.trim() : !changed)}
						className="flex items-center justify-center gap-2 h-[50px] text-base font-semibold bg-primary-hover hover:bg-primary disabled:opacity-50 disabled:cursor-not-allowed text-on-primary rounded-xl transition-colors duration-150 ease-out"
					>
					{isPending && !isRejectPending && <Loader2 size={14} className="animate-spin" />}
					{mode === "edit" &&
						(changed ? t("shiftEdit.saveN", { changes }) : t("common.save"))}
					{mode === "suggest" &&
						(changed ? t("shiftEdit.sendN", { changes }) : t("shiftEdit.send"))}
					{mode === "review" &&
						(changed ? t("shiftEdit.acceptN", { changes }) : t("shiftEdit.accept"))}
					</button>
				</div>
			</div>
		</form>
	);

	return <FullPopup content={content} isModalOpen onClose={onClose} size="md" sheet />;
}
