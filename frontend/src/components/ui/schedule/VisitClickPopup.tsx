import type { VisitWithJob } from "./dashboardCalendarUtils";
import type { Technician } from "../../../types/technicians";
import { VisitStatusColors, VisitStatusLabels } from "../../../types/jobs";
import SchedulePopupShell, {
	SNAPSHOT_BTN_PRIMARY,
	SNAPSHOT_BTN_SECONDARY,
	SNAPSHOT_CHIP,
} from "./SchedulePopupShell";

interface VisitClickPopupProps {
	visit: VisitWithJob;
	/** Caller controls position; `position: "fixed"` renders at <body>. */
	style: React.CSSProperties;
	technicians: Technician[];
	techColorMap: Map<string, string>;
	popupRef?: React.RefObject<HTMLDivElement | null>;
	onClose: () => void;
	onViewVisit: () => void;
	onViewJob: () => void;
	onRescheduleClick?: () => void;
}

export default function VisitClickPopup({
	visit,
	style,
	technicians,
	techColorMap,
	popupRef,
	onClose,
	onViewVisit,
	onViewJob,
	onRescheduleClick,
}: VisitClickPopupProps) {
	const job = visit.job_obj;
	const jobName = job?.name ?? "";
	// Generated visits carry no name of their own, so the job name stands in.
	const title = visit.name?.trim() || jobName || "Visit";
	const subtitle = jobName && jobName !== title ? jobName : null;
	const techs = visit.visit_techs ?? [];

	const crew =
		techs.length > 0
			? {
					content: (
						<div className="flex flex-wrap gap-1">
							{techs.map((vt) => {
								const color =
									techColorMap.get(vt.tech_id) ?? "var(--color-tech-unassigned)";
								const name =
									technicians.find((t) => t.id === vt.tech_id)?.name ??
									vt.tech?.name ??
									vt.tech_id;
								return (
									<span
										key={vt.tech_id}
										className="inline-flex items-center gap-1 rounded-full border px-1.5 text-[10px] leading-4 text-text-on-surface"
										// Tech colors can be var() refs, so alpha comes from color-mix, not a hex suffix.
										style={{
											backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)`,
											borderColor: `color-mix(in srgb, ${color} 35%, transparent)`,
										}}
									>
										<span
											className="h-1.5 w-1.5 rounded-full"
											style={{ backgroundColor: color }}
										/>
										{name}
									</span>
								);
							})}
						</div>
					),
				}
			: { content: "Unassigned", tone: "warn" as const };

	return (
		<SchedulePopupShell
			style={style}
			popupRef={popupRef}
			onClose={onClose}
			chips={
				<span
					className={`${SNAPSHOT_CHIP} ${VisitStatusColors[visit.status] ?? "border-border text-text-tertiary"}`}
				>
					{VisitStatusLabels[visit.status] ?? visit.status}
				</span>
			}
			priority={job?.priority}
			title={title}
			subtitle={subtitle}
			timing={{ ...visit, start: visit.scheduled_start_at, end: visit.scheduled_end_at }}
			crew={crew}
			client={job?.client?.name}
			address={job?.address}
			description={visit.description?.trim() || job?.description?.trim() || null}
			actions={
				<>
					<button type="button" onClick={onViewVisit} className={SNAPSHOT_BTN_PRIMARY}>
						View Visit
					</button>
					<button type="button" onClick={onViewJob} className={SNAPSHOT_BTN_SECONDARY}>
						View Job
					</button>
				</>
			}
			onRescheduleClick={onRescheduleClick}
		/>
	);
}
