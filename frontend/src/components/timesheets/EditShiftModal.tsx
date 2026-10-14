import { useState, type FormEvent } from "react";
import { Loader2, Pencil } from "lucide-react";
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
	camelCaseToRegular,
	errorMessage,
	fmtHours,
	formatDate,
	formatTime,
	toLocalInputValue,
} from "../../util/util";
import type { EditShiftInput, ShiftCorrection, TechWeekDetails } from "../../types/timesheets";

type Day = TechWeekDetails["days"][number];
type Mode = "edit" | "suggest" | "review";
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
};

const COPY: Record<Mode, { title: string; done: string; fail: string }> = {
	edit: { title: "Edit times", done: "Shift times updated", fail: "Failed to update shift times" },
	suggest: { title: "Suggest correct times", done: "Sent to dispatch", fail: "Failed to send suggestion" },
	review: { title: "Review suggested times", done: "Correction accepted", fail: "Failed to accept correction" },
};

const row = (r: Omit<Row, "origStart" | "origEnd">): Row => ({ ...r, origStart: r.start, origEnd: r.end });
const toTime = (iso: string | null) => toLocalInputValue(iso).slice(11);

const toRows = (day: Day): Row[] => [
	row({
		kind: "shift",
		id: day.shiftId,
		label: "Shift",
		sub: "Clock in to clock out",
		unpaid: false,
		start: toTime(day.start),
		end: toTime(day.end),
	}),
	...day.breaks.map((b) =>
		row({
			kind: "break",
			id: b.id,
			label: `${camelCaseToRegular(b.reason)} break`,
			sub: b.is_paid ? "Paid" : "Unpaid",
			unpaid: !b.is_paid,
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
		: rows.map((r) => {
				const [s, e] = proposedFor(p, r);
				return { ...r, start: s ? toTime(s) : r.start, end: e ? toTime(e) : r.end };
			});

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
	const [rows, setRows] = useState(() => withProposed(toRows(day), initial ?? correction?.proposed));
	const [message, setMessage] = useState("");
	const date = toLocalInputValue(day.start).slice(0, 10);
	const anchor = rows[0].start;
	const at = (t: string) => atShiftTime(date, anchor, t);
	const iso = (t: string) => at(t).toISOString();
	const { mutateAsync: editShift, isPending: isEditPending } = useEditShiftMutation();
	const { mutateAsync: reportIssue, isPending: isReportPending } = useReportShiftIssueMutation();
	const { mutateAsync: acceptCorrection, isPending: isAcceptPending } = useAcceptCorrectionMutation();
	const { mutateAsync: rejectCorrection, isPending: isRejectPending } = useRejectCorrectionMutation();
	const isPending = isEditPending || isReportPending || isAcceptPending || isRejectPending;
	const copy = COPY[mode];

	const changed = rows.filter((r) => r.start !== r.origStart || r.end !== r.origEnd).length;
	const gross = hrs(at(rows[0].start), at(rows[0].end));
	const payable = payableOf(rows, date, (r) => [r.start, r.end]);
	const unpaidBreaks = gross - payable;
	const delta = payable - payableOf(rows, date, (r) => [r.origStart, r.origEnd]);
	const changes = `${changed} change${changed === 1 ? "" : "s"}`;
	const note = message.trim() || undefined;

	const setTime = (i: number, field: "start" | "end", value: string) =>
		setRows((prev) => prev.map((r, j) => (j === i ? { ...r, [field]: value } : r)));

	const toInput = (rows: Row[]) => {
		const data: EditShiftInput = { breaks: [], entries: [] };
		for (const r of rows) {
			if (r.kind === "shift") {
				data.started_at = iso(r.start);
				data.ended_at = iso(r.end);
			} else if (r.kind === "break") {
				data.breaks!.push({ id: r.id, started_at: iso(r.start), ended_at: iso(r.end) });
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
			if (mode === "edit") await editShift({ shiftId: day.shiftId, data });
			else if (mode === "suggest")
				await reportIssue({ shiftId: day.shiftId, message, proposed: changed ? data : undefined });
			else await acceptCorrection({ id: correction!.id, note, proposed: data });
			toast.success(copy.done);
			onClose();
		} catch (err) {
			toast.error(errorMessage(err, copy.fail));
		}
	};

	const handleReject = async () => {
		try {
			await rejectCorrection({ id: correction!.id, note });
			toast.success("Correction rejected");
			onClose();
		} catch (err) {
			toast.error(errorMessage(err, "Failed to reject correction"));
		}
	};

	const timeInput = (r: Row, i: number, field: "start" | "end") => {
		const orig = field === "start" ? r.origStart : r.origEnd;
		const dirty = r[field] !== orig;
		return (
			<div className="flex flex-col gap-0.5">
				<input
					type="time"
					required
					disabled={mode === "review"}
					value={r[field]}
					onChange={(e) => setTime(i, field, e.target.value)}
					aria-label={`${r.label} ${field}`}
					className={`w-full px-2 py-1.5 text-sm rounded-md text-text-primary focus:outline-none focus:border-primary border ${
						dirty ? "border-primary bg-primary-bg-subtle" : "border-border bg-surface"
					}`}
				/>
				{dirty && (
					<span className="text-xs text-primary-text">
						was {formatTime(atShiftTime(date, rows[0].origStart, orig), tz)}
					</span>
				)}
			</div>
		);
	};

	const content = (
		<form onSubmit={handleSubmit} className="flex flex-col min-h-0">
			<div className="flex items-center gap-2 px-6 py-4 border-b border-border-subtle">
				<Pencil size={18} className="text-text-secondary" />
				<h2 className="text-base font-semibold text-text-primary">
					{copy.title} · {formatDate(day.start, tz)}
				</h2>
			</div>

			<div className="px-6 py-4 overflow-y-auto">
				{mode === "review" && (
					<div className="mb-4 px-4 py-3 bg-surface-raised rounded-lg">
						<p className="text-xs text-text-muted">Tech's message</p>
						<p className="text-sm text-text-primary whitespace-pre-wrap">{correction!.message}</p>
					</div>
				)}

				<div className="grid grid-cols-[minmax(0,1fr)_auto_auto_4.5rem] gap-x-3 gap-y-3 items-start">
					<span />
					<span className="text-xs text-text-muted">Start</span>
					<span className="text-xs text-text-muted">End</span>
					<span className="text-xs text-text-muted text-right">Hours</span>
					{rows.map((r, i) => (
						<div key={r.id} className="contents">
							<div className="min-w-0 pt-1">
								<p className={`text-sm truncate ${r.kind === "shift" ? "font-semibold" : ""}`}>
									{r.label}
								</p>
								<p className="text-xs text-text-muted truncate">{r.sub}</p>
							</div>
							{timeInput(r, i, "start")}
							{timeInput(r, i, "end")}
							<span className="pt-2 text-sm text-right tabular-nums">{fmtHours(hrs(at(r.start), at(r.end)))}</span>
						</div>
					))}
				</div>

				<div className="grid grid-cols-3 gap-3 mt-4 px-4 py-3 bg-surface-raised rounded-lg">
					<div>
						<p className="text-xs text-text-muted">Gross</p>
						<p className="text-text-primary font-semibold tabular-nums">{fmtHours(gross)}</p>
					</div>
					<div>
						<p className="text-xs text-text-muted">Unpaid breaks</p>
						<p className="text-text-primary font-semibold tabular-nums">{fmtHours(unpaidBreaks)}</p>
					</div>
					<div>
						<p className="text-xs text-text-muted">Payable</p>
						<p className="text-text-primary font-semibold tabular-nums">
							{fmtHours(payable)}
							{Math.round(delta * 60) !== 0 && (
								<span className={`ml-1.5 text-xs ${delta > 0 ? "text-success-text" : "text-warning-text"}`}>
									{delta > 0 ? "+" : "−"}
									{fmtHours(Math.abs(delta))}
								</span>
							)}
						</p>
					</div>
				</div>

				{mode !== "edit" && (
					<label className="flex flex-col gap-1.5 mt-4">
						<span className="text-sm font-medium text-text-secondary">
							{mode === "suggest" ? "What looks wrong?" : "Note to tech (optional)"}
						</span>
						<textarea
							required={mode === "suggest"}
							rows={mode === "suggest" ? 4 : 2}
							maxLength={500}
							value={message}
							onChange={(e) => setMessage(e.target.value)}
							placeholder={
								mode === "suggest"
									? "e.g. I forgot to clock out after the job, I left at 4:30"
									: "e.g. Adjusted to match the job notes"
							}
							className="px-3 py-2 text-sm bg-surface border border-border rounded-md text-text-primary resize-none focus:outline-none focus:border-primary"
						/>
						<span className="self-end text-xs text-text-muted tabular-nums">{message.length}/500</span>
					</label>
				)}
			</div>

			<div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border-subtle">
				<button
					type="button"
					onClick={onClose}
					disabled={isPending}
					className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface rounded-md transition-colors duration-150 ease-out disabled:opacity-50"
				>
					Cancel
				</button>
				{mode === "review" && (
					<button
						type="button"
						onClick={handleReject}
						disabled={isPending}
						className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-error-text border border-border hover:bg-error-bg rounded-md transition-colors duration-150 ease-out disabled:opacity-50"
					>
						{isRejectPending && <Loader2 size={14} className="animate-spin" />}
						Reject
					</button>
				)}
				<button
					type="submit"
					disabled={isPending || (mode === "suggest" ? !message.trim() : !changed)}
					className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary-hover hover:bg-primary disabled:opacity-50 disabled:cursor-not-allowed text-on-primary rounded-md transition-colors duration-150 ease-out"
				>
					{isPending && !isRejectPending && <Loader2 size={14} className="animate-spin" />}
					{mode === "edit" && (changed ? `Save ${changes}` : "Save")}
					{mode === "suggest" && (changed ? `Send ${changes} to dispatch` : "Send to dispatch")}
					{mode === "review" && (changed ? `Accept ${changes}` : "Accept")}
				</button>
			</div>
		</form>
	);

	return <FullPopup content={content} isModalOpen onClose={onClose} size="lg" />;
}
