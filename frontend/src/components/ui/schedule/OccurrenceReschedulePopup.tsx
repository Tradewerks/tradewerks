import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowRight, RotateCw } from "lucide-react";
import TimePicker from "../TimePicker";
import type { OccurrenceWithPlan } from "./dashboardCalendarUtils";
import type {
	ArrivalConstraint,
	FinishConstraint,
	RescheduleOccurrenceInput,
} from "../../../types/recurringPlans";
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

type ConflictState = "ok" | "error";

interface ConflictRow {
	name: string;
	timeLabel: string;
}

interface OccurrenceReschedulePopupProps {
	occurrence: OccurrenceWithPlan;
	oldDateStr: string;
	newDateStr: string;
	anchorRect: DOMRect;
	/** Occurrences already on the target date — used to detect same-plan conflicts. */
	allOccurrencesOnNewDay?: OccurrenceWithPlan[];
	/** When provided, overrides formatDateDisplay(oldDateStr) in the move chip — use for drag-triggered reschedules to show times instead of dates. */
	fromLabel?: string;
	/** When provided, overrides formatDateDisplay(newDateStr) in the move chip. */
	toLabel?: string;
	onReschedule: (input: RescheduleOccurrenceInput & { scope: "this" | "future" }) => void;
	onGenerate: (input: Omit<RescheduleOccurrenceInput, "scope">) => void;
	onCancel: () => void;
	isGenerating?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function OccurrenceReschedulePopup({
	occurrence,
	oldDateStr,
	newDateStr,
	anchorRect,
	allOccurrencesOnNewDay,
	fromLabel,
	toLabel,
	onReschedule,
	onGenerate,
	onCancel,
	isGenerating = false,
}: OccurrenceReschedulePopupProps) {
	const origStart = new Date(occurrence.occurrence_start_at);
	const origEnd = new Date(occurrence.occurrence_end_at);

	// Seed constraints from the occurrence itself (populated from rule at generation, may be overridden on reschedule)
	const [arrivalConstraint, setArrivalConstraint] = useState<ArrivalConstraint>(
		occurrence.arrival_constraint
	);
	const [arrivalTime, setArrivalTime] = useState(
		occurrence.arrival_time ?? dateToHHMM(origStart)
	);
	const [arrivalWindowStart, setArrivalWindowStart] = useState(
		occurrence.arrival_window_start ?? dateToHHMM(origStart)
	);
	const [arrivalWindowEnd, setArrivalWindowEnd] = useState(
		occurrence.arrival_window_end ??
			dateToHHMM(new Date(origStart.getTime() + 60 * 60 * 1000))
	);
	const [finishConstraint, setFinishConstraint] = useState<FinishConstraint>(
		occurrence.finish_constraint
	);
	const [finishTime, setFinishTime] = useState(occurrence.finish_time ?? dateToHHMM(origEnd));
	const [occurrenceScope, setOccurrenceScope] = useState<"this" | "future">("this");

	// ── Same-plan conflict detection ─────────────────────────────────────────
	const [conflictState, setConflictState] = useState<ConflictState>("ok");
	const [conflictRows, setConflictRows] = useState<ConflictRow[]>([]);

	useEffect(() => {
		const samePlan = (allOccurrencesOnNewDay ?? []).filter(
			(o) =>
				o.id !== occurrence.id &&
				o.recurring_plan_id === occurrence.recurring_plan_id
		);
		if (samePlan.length === 0) {
			setConflictState("ok");
			setConflictRows([]);
			return;
		}
		setConflictState("error");
		setConflictRows(
			samePlan.map((o) => ({
				name: o.plan.name,
				timeLabel: new Date(o.occurrence_start_at).toLocaleTimeString([], {
					hour: "numeric",
					minute: "2-digit",
				}),
			}))
		);
	}, [allOccurrencesOnNewDay, occurrence.id, occurrence.recurring_plan_id]);

	// ── Pre-fill helpers ─────────────────────────────────────────────────────

	function handleArrivalChange(c: ArrivalConstraint) {
		setArrivalConstraint(c);
		if (c === "at" && !arrivalTime) setArrivalTime(dateToHHMM(origStart));
		else if (c === "between") {
			if (!arrivalWindowStart) setArrivalWindowStart(dateToHHMM(origStart));
			if (!arrivalWindowEnd)
				setArrivalWindowEnd(
					dateToHHMM(new Date(origStart.getTime() + 60 * 60 * 1000))
				);
		} else if (c === "by" && !arrivalWindowEnd)
			setArrivalWindowEnd(dateToHHMM(origEnd));
	}

	function handleFinishChange(c: FinishConstraint) {
		setFinishConstraint(c);
		if ((c === "at" || c === "by") && !finishTime) setFinishTime(dateToHHMM(origEnd));
	}

	// ── Compute new start / end ───────────────────────────────────────────────

	const payload = constraintPayload({
		arrival_constraint: arrivalConstraint,
		arrival_time: arrivalTime,
		arrival_window_start: arrivalWindowStart,
		arrival_window_end: arrivalWindowEnd,
		finish_constraint: finishConstraint,
		finish_time: finishTime,
	});
	// Anchored to the stored start, not the deadline: a `by` occurrence is stored ahead of it.
	const aligned = alignScheduleToConstraints(
		newDateStr,
		{ start: occurrence.occurrence_start_at, end: occurrence.occurrence_end_at },
		occurrence,
		payload
	);
	const computedStart = aligned.start;
	const computedEnd = finishConstraint === "when_done" ? undefined : aligned.end;

	// ── Completion gate ───────────────────────────────────────────────────────

	const isComplete =
		(arrivalConstraint !== "at" || arrivalTime !== "") &&
		(arrivalConstraint !== "between" ||
			(arrivalWindowStart !== "" && arrivalWindowEnd !== "")) &&
		(arrivalConstraint !== "by" || arrivalWindowEnd !== "") &&
		(finishConstraint === "when_done" || finishTime !== "");

	// ── Popup positioning ─────────────────────────────────────────────────────

	const { top: popupTop, left: popupLeft } = getAnchoredPopupPos(anchorRect, {
		popupW: RESCHEDULE_POPUP_W,
		popupH: 472,
	});

	// ── Actions ───────────────────────────────────────────────────────────────

	return createPortal(
		<>
			{/* Backdrop */}
			<div
				style={{ position: "fixed", inset: 0, zIndex: 1000 }}
				onClick={onCancel}
			/>

			{/* Popup */}
			<div
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
				<div
					style={{
						padding: "10px 12px 9px",
						borderBottom: "1px solid var(--color-border-subtle)",
					}}
				>
					<div
						style={{
							fontSize: 12,
							fontWeight: 700,
							color: "var(--color-sched-text-primary)",
							letterSpacing: "-0.01em",
							marginBottom: 2,
						}}
					>
						Reschedule Occurrence
					</div>
					<div
						style={{
							fontSize: 11,
							color: "var(--color-text-tertiary)",
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
						}}
					>
						{occurrence.plan.name}
					</div>
				</div>

				<div
					style={{
						padding: "10px 12px",
						display: "flex",
						flexDirection: "column",
						gap: 10,
					}}
				>
					{/* Move chip */}
					<div
						style={{
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
						}}
					>
						{!fromLabel &&
						!toLabel &&
						oldDateStr === newDateStr ? (
							<>
								<span style={{ color: "var(--color-text-muted)" }}>
									Same Day
								</span>
								<span style={{ color: "var(--color-border)" }}>
									:
								</span>
								<span
									style={{
										color: "var(--color-primary-text)",
										fontWeight: 600,
									}}
								>
									{formatDateDisplay(
										newDateStr
									)}
								</span>
							</>
						) : (
							<>
								<span style={{ color: "var(--color-text-muted)" }}>
									{fromLabel ??
										formatDateDisplay(
											oldDateStr
										)}
								</span>
								<ArrowRight
									size={11}
									style={{
										color: "var(--color-primary)",
										flexShrink: 0,
									}}
								/>
								<span
									style={{
										color: "var(--color-primary-text)",
										fontWeight: 600,
									}}
								>
									{toLabel ??
										formatDateDisplay(
											newDateStr
										)}
								</span>
							</>
						)}
					</div>

					{/* Two-column constraint form */}
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "1fr 1px 1fr",
						}}
					>
						{/* Arrival column */}
						<div
							style={{
								paddingRight: 10,
								display: "flex",
								flexDirection: "column",
								gap: 6,
							}}
						>
							<div style={POPUP_LABEL_STYLE}>Arrival</div>
							<select
								value={arrivalConstraint}
								onChange={(e) =>
									handleArrivalChange(
										e.target
											.value as ArrivalConstraint
									)
								}
								style={POPUP_SELECT_STYLE}
								onFocus={(e) => (e.currentTarget.style.borderColor = "var(--color-primary)")}
								onBlur={(e) => (e.currentTarget.style.borderColor = "var(--color-border)")}
							>
								<option value="anytime">
									Anytime
								</option>
								<option value="at">
									Arrive at
								</option>
								<option value="between">
									Between
								</option>
								<option value="by">
									Arrive by
								</option>
							</select>

							{arrivalConstraint === "at" && (
								<TimePicker
									value={hhmmToPickerDate(
										arrivalTime
									)}
									onChange={(d) =>
										setArrivalTime(
											dateToHHMM(
												d
											)
										)
									}
									compact
								/>
							)}
							{arrivalConstraint === "between" && (
								<div
									style={{
										display: "flex",
										flexDirection: "column",
										gap: 4,
									}}
								>
									<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
										<span style={{ fontSize: 9, color: "var(--color-text-tertiary)", minWidth: 22, flexShrink: 0 }}>From</span>
										<div style={{ flex: 1, minWidth: 0 }}>
											<TimePicker
												value={hhmmToPickerDate(arrivalWindowStart)}
												onChange={(d) =>
													setArrivalWindowStart(
														dateToHHMM(d)
													)
												}
												compact
											/>
										</div>
									</div>
									<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
										<span style={{ fontSize: 9, color: "var(--color-text-tertiary)", minWidth: 22, flexShrink: 0 }}>To</span>
										<div style={{ flex: 1, minWidth: 0 }}>
											<TimePicker
												value={hhmmToPickerDate(arrivalWindowEnd)}
												onChange={(d) =>
													setArrivalWindowEnd(
														dateToHHMM(d)
													)
												}
												compact
											/>
										</div>
									</div>
								</div>
							)}
							{arrivalConstraint === "by" && (
								<TimePicker
									value={hhmmToPickerDate(
										arrivalWindowEnd
									)}
									onChange={(d) =>
										setArrivalWindowEnd(
											dateToHHMM(
												d
											)
										)
									}
									compact
								/>
							)}
							{arrivalConstraint === "anytime" && (
								<div style={POPUP_MUTED_STYLE}>
									No time required
								</div>
							)}
						</div>

						{/* Divider */}
						<div
							style={{
								backgroundColor: "var(--color-surface)",
								alignSelf: "stretch",
							}}
						/>

						{/* Finish column */}
						<div
							style={{
								paddingLeft: 10,
								display: "flex",
								flexDirection: "column",
								gap: 6,
							}}
						>
							<div style={POPUP_LABEL_STYLE}>Finish</div>
							<select
								value={finishConstraint}
								onChange={(e) =>
									handleFinishChange(
										e.target
											.value as FinishConstraint
									)
								}
								style={POPUP_SELECT_STYLE}
								onFocus={(e) => (e.currentTarget.style.borderColor = "var(--color-primary)")}
								onBlur={(e) => (e.currentTarget.style.borderColor = "var(--color-border)")}
							>
								<option value="when_done">
									When done
								</option>
								<option value="at">
									Finish at
								</option>
								<option value="by">
									Finish by
								</option>
							</select>

							{(finishConstraint === "at" ||
								finishConstraint === "by") && (
								<TimePicker
									value={hhmmToPickerDate(
										finishTime
									)}
									onChange={(d) =>
										setFinishTime(
											dateToHHMM(
												d
											)
										)
									}
									compact
								/>
							)}
							{finishConstraint === "when_done" && (
								<div style={POPUP_MUTED_STYLE}>
									No time required
								</div>
							)}
						</div>
					</div>

					{/* Same-plan conflict warning */}
					{conflictState === "error" && (
						<div
							style={{
								borderRadius: 6,
								overflow: "hidden",
								border: "1px solid rgba(239,68,68,0.25)",
							}}
						>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: 5,
									padding: "5px 8px",
									backgroundColor:
										"rgba(239,68,68,0.1)",
									borderBottom:
										"1px solid rgba(239,68,68,0.15)",
								}}
							>
								<AlertTriangle
									size={10}
									style={{
										color: "var(--color-error-text)",
										flexShrink: 0,
									}}
								/>
								<span
									style={{
										fontSize: 9,
										fontWeight: 600,
										color: "var(--color-error-text)",
										textTransform:
											"uppercase",
										letterSpacing:
											"0.05em",
									}}
								>
									Scheduling conflict
								</span>
							</div>
							<div
								style={{
									padding: "5px 8px",
									display: "flex",
									flexDirection: "column",
									gap: 3,
								}}
							>
								{conflictRows.map((row, i) => (
									<div
										key={i}
										style={{
											display: "flex",
											alignItems: "center",
											gap: 5,
											fontSize: 9,
											color: "var(--color-error-text)",
											minWidth: 0,
										}}
									>
										<span
											style={{
												width: 6,
												height: 6,
												borderRadius:
													"50%",
												backgroundColor:
													"var(--color-reviewing-text)",
												flexShrink: 0,
											}}
										/>
										<span
											style={{
												overflow: "hidden",
												textOverflow:
													"ellipsis",
												whiteSpace: "nowrap",
												flex: 1,
												minWidth: 0,
											}}
										>
											{row.name}
										</span>
										<span
											style={{
												color: "var(--color-text-muted)",
												flexShrink: 0,
											}}
										>
											{
												row.timeLabel
											}
										</span>
									</div>
								))}
							</div>
						</div>
					)}

					{/* Scope selector */}
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							gap: 4,
						}}
					>
						<div style={POPUP_LABEL_STYLE}>Apply to</div>
						<div style={{ display: "flex", gap: 4 }}>
							{(["this", "future"] as const).map(
								(scope) => (
									<button
										key={scope}
										onClick={() =>
											setOccurrenceScope(
												scope
											)
										}
										style={{
											flex: 1,
											height: 26,
											fontSize: 11,
											fontWeight: 500,
											padding: "0 8px",
											borderRadius: 4,
											border: "1px solid",
											cursor: "pointer",
											backgroundColor:
												occurrenceScope ===
												scope
													? "var(--color-sched-occurrence-badge)"
													: "transparent",
											borderColor:
												occurrenceScope ===
												scope
													? "var(--color-sched-occurrence-badge)"
													: "rgba(139,92,246,0.35)",
											color:
												occurrenceScope ===
												scope
													? "#fff"
													: "var(--color-reviewing-text)",
											fontFamily: "inherit",
											transition: "background-color 0.15s, border-color 0.15s, color 0.15s",
										}}
									>
										{scope === "this"
											? "This occurrence"
											: "This & all future"}
									</button>
								)
							)}
						</div>
					</div>
				</div>

				{/* Footer */}
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						padding: "8px 12px",
						borderTop: "1px solid var(--color-border-subtle)",
						gap: 6,
					}}
				>
					{/* Cancel — left */}
					<button
						onClick={onCancel}
						style={{
							display: "flex",
							alignItems: "center",
							gap: 5,
							height: 28,
							fontSize: 11,
							fontWeight: 400,
							color: "var(--color-text-tertiary)",
							background: "none",
							border: "1px solid var(--color-border)",
							borderRadius: 6,
							cursor: "pointer",
							padding: "0 9px",
							fontFamily: "inherit",
							transition: "color 0.15s",
						}}
						onMouseEnter={(e) => {
							(
								e.currentTarget as HTMLElement
							).style.color = "var(--color-sched-text-secondary)";
						}}
						onMouseLeave={(e) => {
							(
								e.currentTarget as HTMLElement
							).style.color = "var(--color-text-tertiary)";
						}}
					>
						Cancel
					</button>

					{/* Action buttons — right */}
					<div style={{ display: "flex", gap: 5 }}>
						{/* Reschedule — secondary outlined */}
						<button
							onClick={
								isComplete
									? () => {
											onReschedule(
												{
													new_start_at:
														computedStart.toISOString(),
													new_end_at: computedEnd?.toISOString(),
													scope: occurrenceScope,
													...payload,
												}
											);
										}
									: undefined
							}
							disabled={!isComplete}
							style={{
								height: 28,
								minWidth: 90,
								fontSize: 11,
								fontWeight: 600,
								padding: "0 12px",
								borderRadius: 6,
								border: "1px solid",
								borderColor: isComplete
									? "rgba(59,130,246,0.45)"
									: "var(--color-border)",
								backgroundColor: "transparent",
								color: isComplete
									? "var(--color-visit-driving-text)"
									: "var(--color-text-faint)",
								cursor: isComplete
									? "pointer"
									: "default",
								fontFamily: "inherit",
								opacity: isComplete ? 1 : 0.5,
								transition: "background-color 0.15s, border-color 0.15s, color 0.15s, opacity 0.15s",
							}}
							onMouseEnter={(e) => {
								if (isComplete) {
									(
										e.currentTarget as HTMLElement
									).style.backgroundColor =
										"rgba(59,130,246,0.1)";
								}
							}}
							onMouseLeave={(e) => {
								(
									e.currentTarget as HTMLElement
								).style.backgroundColor =
									"transparent";
							}}
						>
							Save
						</button>

						{/* Generate Visit — primary solid */}
						<button
							onClick={
								isComplete && !isGenerating
									? () => {
											onGenerate({
												new_start_at:
													computedStart.toISOString(),
												new_end_at: computedEnd?.toISOString(),
												...payload,
											});
										}
									: undefined
							}
							disabled={!isComplete || isGenerating}
							style={{
								display: "inline-flex",
								alignItems: "center",
								justifyContent: "center",
								gap: 5,
								height: 28,
								minWidth: 110,
								fontSize: 11,
								fontWeight: 600,
								padding: "0 12px",
								borderRadius: 6,
								border: "none",
								backgroundColor: "var(--color-primary)",
								color: "#fff",
								cursor:
									isComplete && !isGenerating
										? "pointer"
										: "default",
								fontFamily: "inherit",
								opacity:
									!isComplete || isGenerating
										? 0.55
										: 1,
								transition: "background-color 0.15s, opacity 0.15s",
							}}
							onMouseEnter={(e) => {
								if (isComplete && !isGenerating)
									(
										e.currentTarget as HTMLElement
									).style.backgroundColor =
										"var(--color-primary-hover)";
							}}
							onMouseLeave={(e) => {
								(
									e.currentTarget as HTMLElement
								).style.backgroundColor = "var(--color-primary)";
							}}
						>
							{isGenerating ? (
								<>
									<RotateCw
										size={12}
										className="animate-spin"
									/>{" "}
									Generating…
								</>
							) : (
								"Generate Visit"
							)}
						</button>
					</div>
				</div>
			</div>
		</>,
		document.body,
	);
}
