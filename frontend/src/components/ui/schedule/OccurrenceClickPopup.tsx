import { Repeat, RotateCw } from "lucide-react";
import type { OccurrenceWithPlan } from "./dashboardCalendarUtils";
import SchedulePopupShell, {
	SNAPSHOT_BTN_PRIMARY,
	SNAPSHOT_BTN_SECONDARY,
	SNAPSHOT_CHIP,
} from "./SchedulePopupShell";

interface OccurrenceClickPopupProps {
	occurrence: OccurrenceWithPlan;
	/** Caller controls position; `position: "fixed"` renders at <body>. */
	style: React.CSSProperties;
	popupRef?: React.RefObject<HTMLDivElement | null>;
	isGenerating?: boolean;
	onClose: () => void;
	onViewPlan: () => void;
	onGenerate: () => void;
	onRescheduleClick?: () => void;
}

export default function OccurrenceClickPopup({
	occurrence,
	style,
	popupRef,
	isGenerating = false,
	onClose,
	onViewPlan,
	onGenerate,
	onRescheduleClick,
}: OccurrenceClickPopupProps) {
	const { plan, job_obj: job } = occurrence;
	const title = plan.name?.trim() || job?.name || "Recurring visit";
	const subtitle = job?.name && job.name !== title ? job.name : null;

	return (
		<SchedulePopupShell
			style={style}
			popupRef={popupRef}
			onClose={onClose}
			chips={
				<>
					<span className={`${SNAPSHOT_CHIP} border-plan/30 bg-plan/15 text-plan-text`}>
						<Repeat size={9} aria-hidden />
						Recurring
					</span>
					<span className={`${SNAPSHOT_CHIP} border-border text-text-tertiary`}>
						Planned
					</span>
				</>
			}
			priority={plan.priority}
			title={title}
			subtitle={subtitle}
			timing={{
				...occurrence,
				start: occurrence.occurrence_start_at,
				end: occurrence.occurrence_end_at,
			}}
			// Occurrences carry no crew; techs are picked when the visit is generated.
			crew={{ content: "Assigned when generated", tone: "muted" }}
			client={plan.client?.name ?? job?.client?.name}
			address={plan.address || job?.address}
			description={plan.description?.trim() || null}
			actions={
				<>
					<button
						type="button"
						onClick={onGenerate}
						disabled={isGenerating}
						className={SNAPSHOT_BTN_PRIMARY}
					>
						{isGenerating ? (
							<>
								<RotateCw size={11} className="animate-spin" aria-hidden />
								Generating…
							</>
						) : (
							"Generate Visit"
						)}
					</button>
					<button type="button" onClick={onViewPlan} className={SNAPSHOT_BTN_SECONDARY}>
						View Plan
					</button>
				</>
			}
			onRescheduleClick={onRescheduleClick}
		/>
	);
}
