import { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowRight, RotateCcw, RotateCw } from "lucide-react";
import TimePicker from "../TimePicker";
import type { UpdateJobVisitInput } from "../../../types/jobs";
import type { ArrivalConstraint, FinishConstraint } from "../../../types/recurringPlans";
import type { Technician } from "../../../types/technicians";
import type { VisitWithJob } from "./dashboardCalendarUtils";
import {
	alignScheduleToConstraints,
	formatDateDisplay,
	dateToHHMM,
	hhmmToPickerDate,
	POPUP_LABEL_STYLE,
	POPUP_MUTED_STYLE,
	POPUP_SELECT_STYLE,
	RESCHEDULE_POPUP_W,
	constraintPayload,
	getAnchoredPopupPos,
} from "./scheduleBoardUtils";

interface ConflictRow {
	techName: string;
	techColor: string;
	visitName: string;
	timeRange: string;
}

type ConflictState = "ok" | "checking" | "error";

interface ReschedulePopupProps {
	visit: VisitWithJob;
	oldDateStr: string;
	newDateStr: string;
	allVisitsOnNewDay: VisitWithJob[];
	technicians: Technician[];
	techColorMap: Map<string, string>;
	anchorRect: DOMRect;
	/** When provided, overrides formatDateDisplay(oldDateStr) in the move chip — use for drag-triggered reschedules to show times instead of dates. */
	fromLabel?: string;
	/** When provided, overrides formatDateDisplay(newDateStr) in the move chip. */
	toLabel?: string;
	onSave: (data: UpdateJobVisitInput) => void;
	onUndo: () => void;
}

function formatTimeSimple(d: Date): string {
	const h = d.getHours();
	const m = d.getMinutes();
	const period = h >= 12 ? "PM" : "AM";
	const displayH = h % 12 || 12;
	return m === 0 ? `${displayH} ${period}` : `${displayH}:${String(m).padStart(2, "0")} ${period}`;
}

function detectConflicts(
	visitId: string,
	newStart: Date,
	newEnd: Date,
	assignedTechIds: string[],
	allVisitsOnNewDay: VisitWithJob[],
	technicians: Technician[],
	techColorMap: Map<string, string>,
): ConflictRow[] {
	const rows: ConflictRow[] = [];
	for (const v of allVisitsOnNewDay) {
		if (v.id === visitId) continue;
		const vTechIds = (v.visit_techs ?? []).map((vt) => vt.tech_id);
		const shared = assignedTechIds.filter((id) => vTechIds.includes(id));
		if (shared.length === 0) continue;
		const vStart = new Date(v.scheduled_start_at);
		const vEnd = new Date(v.scheduled_end_at);
		if (newStart < vEnd && vStart < newEnd) {
			for (const techId of shared) {
				rows.push({
					techName: technicians.find((t) => t.id === techId)?.name ?? techId,
					techColor: techColorMap.get(techId) ?? "var(--color-tech-unassigned)",
					visitName: v.job_obj?.name ?? "Visit",
					timeRange: `${formatTimeSimple(vStart)}–${formatTimeSimple(vEnd)}`,
				});
			}
		}
	}
	return rows;
}

/** "HH:MM" from a Date string (scheduled_start_at / _end_at) */
function scheduledToHHMM(iso: string | Date): string {
	const d = typeof iso === "string" ? new Date(iso) : iso;
	return dateToHHMM(d);
}

export default function ReschedulePopup({
	visit,
	oldDateStr,
	newDateStr,
	allVisitsOnNewDay,
	technicians,
	techColorMap,
	anchorRect,
	fromLabel,
	toLabel,
	onSave,
	onUndo,
}: ReschedulePopupProps) {
	const [arrivalConstraint, setArrivalConstraint] = useState<ArrivalConstraint>(
		visit.arrival_constraint as ArrivalConstraint
	);
	const [arrivalTime, setArrivalTime] = useState(visit.arrival_time ?? "");
	const [arrivalWindowStart, setArrivalWindowStart] = useState(visit.arrival_window_start ?? "");
	const [arrivalWindowEnd, setArrivalWindowEnd] = useState(visit.arrival_window_end ?? "");
	const [finishConstraint, setFinishConstraint] = useState<FinishConstraint>(
		visit.finish_constraint as FinishConstraint
	);
	const [finishTime, setFinishTime] = useState(visit.finish_time ?? "");
	const [recurringScope, setRecurringScope] = useState<"this" | "future">("this");
	const [conflictState, setConflictState] = useState<ConflictState>("checking");
	const [conflictRows, setConflictRows] = useState<ConflictRow[]>([]);
	const popupRef = useRef<HTMLDivElement>(null);

	const assignedTechIds = (visit.visit_techs ?? []).map((vt) => vt.tech_id);
	const isRecurring = !!visit.job_obj?.recurring_plan;

	// Save is only valid when every selected constraint type has its required time filled
	const isComplete =
		(arrivalConstraint !== "at"      || arrivalTime !== "") &&
		(arrivalConstraint !== "between" || (arrivalWindowStart !== "" && arrivalWindowEnd !== "")) &&
		(arrivalConstraint !== "by"      || arrivalWindowEnd !== "") &&
		(finishConstraint === "when_done" || finishTime !== "");

	// When switching arrival constraint type, pre-fill times from scheduled values so
	// the new inputs are never blank and the user doesn't have to type from scratch.
	function handleArrivalConstraintChange(newC: ArrivalConstraint) {
		setArrivalConstraint(newC);
		if (newC === "at" && !arrivalTime)
			setArrivalTime(scheduledToHHMM(visit.scheduled_start_at));
		else if (newC === "between") {
			if (!arrivalWindowStart) setArrivalWindowStart(scheduledToHHMM(visit.scheduled_start_at));
			if (!arrivalWindowEnd)   setArrivalWindowEnd(scheduledToHHMM(visit.scheduled_end_at));
		} else if (newC === "by" && !arrivalWindowEnd)
			setArrivalWindowEnd(scheduledToHHMM(visit.scheduled_end_at));
	}

	function handleFinishConstraintChange(newC: FinishConstraint) {
		setFinishConstraint(newC);
		if ((newC === "at" || newC === "by") && !finishTime)
			setFinishTime(scheduledToHHMM(visit.scheduled_end_at));
	}

	// True when the user has edited any constraint field from its original value
	const hasChanges =
		arrivalConstraint !== (visit.arrival_constraint as ArrivalConstraint) ||
		arrivalTime        !== (visit.arrival_time         ?? "") ||
		arrivalWindowStart !== (visit.arrival_window_start ?? "") ||
		arrivalWindowEnd   !== (visit.arrival_window_end   ?? "") ||
		finishConstraint   !== (visit.finish_constraint    as FinishConstraint) ||
		finishTime         !== (visit.finish_time          ?? "");

	const edited = useMemo(
		() =>
			constraintPayload({
				arrival_constraint: arrivalConstraint,
				arrival_time: arrivalTime,
				arrival_window_start: arrivalWindowStart,
				arrival_window_end: arrivalWindowEnd,
				finish_constraint: finishConstraint,
				finish_time: finishTime,
			}),
		[
			arrivalConstraint,
			arrivalTime,
			arrivalWindowStart,
			arrivalWindowEnd,
			finishConstraint,
			finishTime,
		]
	);

	// Run conflict detection whenever timing constraints change
	useEffect(() => {
		setConflictState("checking");
		const timer = setTimeout(() => {
			const { start: checkStart, end: checkEnd } = alignScheduleToConstraints(
				newDateStr,
				{ start: visit.scheduled_start_at, end: visit.scheduled_end_at },
				visit,
				edited
			);

			const rows = detectConflicts(
				visit.id,
				checkStart,
				checkEnd,
				assignedTechIds,
				allVisitsOnNewDay,
				technicians,
				techColorMap,
			);
			setConflictRows(rows);
			setConflictState(rows.length > 0 ? "error" : "ok");
		}, 150);
		return () => clearTimeout(timer);
	}, [edited]);

	const { top: popupTop, left: popupLeft } = getAnchoredPopupPos(anchorRect, {
		popupW: RESCHEDULE_POPUP_W,
		popupH: 512,
	});

	function handleUndo() {
		setArrivalConstraint(visit.arrival_constraint as ArrivalConstraint);
		setArrivalTime(visit.arrival_time ?? "");
		setArrivalWindowStart(visit.arrival_window_start ?? "");
		setArrivalWindowEnd(visit.arrival_window_end ?? "");
		setFinishConstraint(visit.finish_constraint as FinishConstraint);
		setFinishTime(visit.finish_time ?? "");
	}

	function handleSave() {
		const { start, end } = alignScheduleToConstraints(
			newDateStr,
			{ start: visit.scheduled_start_at, end: visit.scheduled_end_at },
			visit,
			edited
		);
		const data: UpdateJobVisitInput = {
			scheduled_start_at: start.toISOString(),
			scheduled_end_at: end.toISOString(),
			...edited,
			...(isRecurring && { reschedule_scope: recurringScope }),
		};
		onSave(data);
	}

	return createPortal(
		<>
			{/* Backdrop */}
			<div
				style={{ position: "fixed", inset: 0, zIndex: 1000 }}
				onClick={onUndo}
			/>

			{/* Popup */}
			<div
				ref={popupRef}
				style={{
					position: "fixed",
					top: popupTop,
					left: popupLeft,
					width: RESCHEDULE_POPUP_W,
					zIndex: 1001,
					backgroundColor: "var(--color-popup-bg)",
					border: "1px solid var(--color-border)",
					borderRadius: 8,
					boxShadow: "0 0 0 1px rgba(255,255,255,0.04), 0 8px 32px rgba(0,0,0,0.7)",
					overflow: "hidden",
					fontFamily: "inherit",
				}}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div style={{ padding: "10px 12px 9px", borderBottom: "1px solid var(--color-border-subtle)" }}>
					<div style={{
						fontSize: 12,
						fontWeight: 700,
						color: "var(--color-sched-text-primary)",
						letterSpacing: "-0.01em",
						marginBottom: 2,
					}}>
						Reschedule Visit
					</div>
					<div style={{
						fontSize: 11,
						color: "var(--color-text-tertiary)",
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
					}}>
						{visit.job_obj?.name}
					</div>
				</div>

				<div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 10 }}>

					{/* Move chip — content-width, centered */}
					<div style={{
						display: "flex",
						alignItems: "center",
						gap: 6,
						fontSize: 11,
						backgroundColor: "rgba(59,130,246,0.06)",
						border: "1px solid rgba(59,130,246,0.14)",
						borderRadius: 6,
						padding: "6px 10px",
						width: "fit-content",
						margin: "0 auto",
					}}>
						{!fromLabel && !toLabel && oldDateStr === newDateStr ? (
							<>
								<span style={{ color: "var(--color-text-muted)" }}>Same Day</span>
								<span style={{ color: "var(--color-border)" }}>:</span>
								<span style={{ color: "var(--color-primary-text)", fontWeight: 600 }}>{formatDateDisplay(newDateStr)}</span>
							</>
						) : (
							<>
								<span style={{ color: "var(--color-text-muted)" }}>{fromLabel ?? formatDateDisplay(oldDateStr)}</span>
								<ArrowRight size={11} style={{ color: "var(--color-primary)", flexShrink: 0 }} />
								<span style={{ color: "var(--color-primary-text)", fontWeight: 600 }}>{toLabel ?? formatDateDisplay(newDateStr)}</span>
							</>
						)}
					</div>

					{/* Two-column constraint form */}
					<div style={{ display: "grid", gridTemplateColumns: "1fr 1px 1fr" }}>

						{/* Arrival column */}
						<div style={{ paddingRight: 10, display: "flex", flexDirection: "column", gap: 6 }}>
							<div style={POPUP_LABEL_STYLE}>Arrival</div>
							<select
								value={arrivalConstraint}
								onChange={(e) => handleArrivalConstraintChange(e.target.value as ArrivalConstraint)}
								style={POPUP_SELECT_STYLE}
								onFocus={(e) => (e.currentTarget.style.borderColor = "var(--color-primary)")}
								onBlur={(e) => (e.currentTarget.style.borderColor = "var(--color-border)")}
							>
								<option value="anytime">Anytime</option>
								<option value="at">Arrive at</option>
								<option value="between">Between</option>
								<option value="by">Arrive by</option>
							</select>

							{arrivalConstraint === "at" && (
								<TimePicker
									value={hhmmToPickerDate(arrivalTime)}
									onChange={(d) => setArrivalTime(dateToHHMM(d))}
									compact
								/>
							)}
							{arrivalConstraint === "between" && (
								<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
									<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
										<span style={{ fontSize: 9, color: "var(--color-text-tertiary)", minWidth: 22, flexShrink: 0 }}>From</span>
										<div style={{ flex: 1, minWidth: 0 }}>
											<TimePicker
												value={hhmmToPickerDate(arrivalWindowStart)}
												onChange={(d) => setArrivalWindowStart(dateToHHMM(d))}
												compact
											/>
										</div>
									</div>
									<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
										<span style={{ fontSize: 9, color: "var(--color-text-tertiary)", minWidth: 22, flexShrink: 0 }}>To</span>
										<div style={{ flex: 1, minWidth: 0 }}>
											<TimePicker
												value={hhmmToPickerDate(arrivalWindowEnd)}
												onChange={(d) => setArrivalWindowEnd(dateToHHMM(d))}
												compact
											/>
										</div>
									</div>
								</div>
							)}
							{arrivalConstraint === "by" && (
								<TimePicker
									value={hhmmToPickerDate(arrivalWindowEnd)}
									onChange={(d) => setArrivalWindowEnd(dateToHHMM(d))}
									compact
								/>
							)}
							{arrivalConstraint === "anytime" && (
								<div style={POPUP_MUTED_STYLE}>No time required</div>
							)}
						</div>

						{/* Divider */}
						<div style={{ backgroundColor: "var(--color-surface)", alignSelf: "stretch" }} />

						{/* Finish column */}
						<div style={{ paddingLeft: 10, display: "flex", flexDirection: "column", gap: 6 }}>
							<div style={POPUP_LABEL_STYLE}>Finish</div>
							<select
								value={finishConstraint}
								onChange={(e) => handleFinishConstraintChange(e.target.value as FinishConstraint)}
								style={POPUP_SELECT_STYLE}
								onFocus={(e) => (e.currentTarget.style.borderColor = "var(--color-primary)")}
								onBlur={(e) => (e.currentTarget.style.borderColor = "var(--color-border)")}
							>
								<option value="when_done">When done</option>
								<option value="at">Finish at</option>
								<option value="by">Finish by</option>
							</select>

							{(finishConstraint === "at" || finishConstraint === "by") && (
								<TimePicker
									value={hhmmToPickerDate(finishTime)}
									onChange={(d) => setFinishTime(dateToHHMM(d))}
									compact
								/>
							)}
							{finishConstraint === "when_done" && (
								<div style={POPUP_MUTED_STYLE}>No time required</div>
							)}
						</div>
					</div>

					{/* Conflict box */}
					{conflictState === "error" && (
						<div style={{
							borderRadius: 6,
							overflow: "hidden",
							border: "1px solid rgba(239,68,68,0.25)",
						}}>
							<div style={{
								display: "flex",
								alignItems: "center",
								gap: 5,
								padding: "5px 8px",
								backgroundColor: "rgba(239,68,68,0.1)",
								borderBottom: "1px solid rgba(239,68,68,0.15)",
							}}>
								<AlertTriangle size={10} style={{ color: "var(--color-error-text)", flexShrink: 0 }} />
								<span style={{ fontSize: 9, fontWeight: 600, color: "var(--color-error-text)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
									Scheduling conflict
								</span>
							</div>
							<div style={{ padding: "5px 8px", display: "flex", flexDirection: "column", gap: 3 }}>
								{conflictRows.map((row, i) => (
									<div key={i} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 9, color: "var(--color-error-text)", minWidth: 0 }}>
										<span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: row.techColor, flexShrink: 0 }} />
										<span style={{ fontWeight: 600, flexShrink: 0 }}>{row.techName}</span>
										<span style={{ color: "var(--color-text-faint)", flexShrink: 0 }}>·</span>
										<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{row.visitName}</span>
										<span style={{ color: "var(--color-text-muted)", flexShrink: 0 }}>{row.timeRange}</span>
									</div>
								))}
							</div>
						</div>
					)}

					{/* Apply to — recurring scope, after conflict box */}
					{isRecurring && (
						<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
							<div style={POPUP_LABEL_STYLE}>Apply to</div>
							<div style={{ display: "flex", gap: 4 }}>
								{(["this", "future"] as const).map((scope) => (
									<button
										key={scope}
										onClick={() => setRecurringScope(scope)}
										style={{
											flex: 1,
											height: 26,
											fontSize: 11,
											fontWeight: 500,
											padding: "0 8px",
											borderRadius: 4,
											border: "1px solid",
											cursor: "pointer",
											backgroundColor: recurringScope === scope ? "var(--color-sched-occurrence-badge)" : "transparent",
											borderColor: recurringScope === scope ? "var(--color-sched-occurrence-badge)" : "rgba(139,92,246,0.35)",
											color: recurringScope === scope ? "#fff" : "var(--color-reviewing-text)",
											fontFamily: "inherit",
											transition: "background-color 0.15s, border-color 0.15s, color 0.15s",
										}}
									>
										{scope === "this" ? "This visit only" : "This & all future"}
									</button>
								))}
							</div>
						</div>
					)}
				</div>

				{/* Footer */}
				<div style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					padding: "8px 12px",
					borderTop: "1px solid var(--color-border-subtle)",
					gap: 6,
				}}>
					<button
						onClick={hasChanges ? handleUndo : onUndo}
						style={{
							display: "flex",
							alignItems: "center",
							gap: 5,
							height: 28,
							fontSize: 11,
							fontWeight: hasChanges ? 600 : 400,
							color: hasChanges ? "var(--color-warning)" : "var(--color-text-tertiary)",
							background: hasChanges ? "rgba(245,158,11,0.08)" : "none",
							border: hasChanges ? "1px solid rgba(245,158,11,0.22)" : "1px solid var(--color-border)",
							borderRadius: 6,
							cursor: "pointer",
							padding: "0 9px",
							fontFamily: "inherit",
							transition: "color 0.15s, background 0.15s, border-color 0.15s",
						}}
						onMouseEnter={(e) => {
							(e.currentTarget as HTMLElement).style.color = hasChanges ? "var(--color-warning-text)" : "var(--color-sched-text-secondary)";
						}}
						onMouseLeave={(e) => {
							(e.currentTarget as HTMLElement).style.color = hasChanges ? "var(--color-warning)" : "var(--color-text-tertiary)";
						}}
					>
						{hasChanges && <RotateCcw size={11} />}
						{hasChanges ? "Undo changes" : "Cancel"}
					</button>

					<button
						onClick={(!isComplete || conflictState === "checking") ? undefined : handleSave}
						style={{
							display: "inline-flex",
							alignItems: "center",
							justifyContent: "center",
							height: 28,
							minWidth: 64,
							fontSize: 11,
							fontWeight: 600,
							padding: "0 12px",
							borderRadius: 6,
							border: "none",
							backgroundColor: "var(--color-primary)",
							color: "#fff",
							cursor: (!isComplete || conflictState === "checking") ? "default" : "pointer",
							fontFamily: "inherit",
							transition: "background-color 0.15s, opacity 0.15s",
							opacity: !isComplete ? 0.45 : 1,
							pointerEvents: (!isComplete || conflictState === "checking") ? "none" : "auto",
						}}
						onMouseEnter={(e) => {
							if (isComplete && conflictState !== "checking")
								(e.currentTarget as HTMLElement).style.backgroundColor = "var(--color-primary-hover)";
						}}
						onMouseLeave={(e) => {
							(e.currentTarget as HTMLElement).style.backgroundColor = "var(--color-primary)";
						}}
					>
						{conflictState === "checking"
							? <RotateCw size={12} className="animate-spin" />
							: "Save"
						}
					</button>
				</div>
			</div>
		</>,
		document.body,
	);
}
