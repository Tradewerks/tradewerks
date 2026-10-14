import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Technician, VisitTechnician } from "../../types/technicians";
import { VisitStatusColors, VisitStatusLabels, type VisitStatus } from "../../types/jobs";
import { getTechnicianActivity } from "./technicianActivity";
import { formatTime } from "./technicianFormat";
import { TodayProgress } from "./TechnicianBits";

// Copied verbatim from LifecycleBar's outer <div> (Step 0, resolved for the
// default "normal" stage with no tone/offRamp override) so the strip fills
// the lifecycle-bar slot with identical chrome.
const STRIP_CHROME =
	"flex flex-wrap justify-between gap-x-6 gap-y-3 rounded-lg border px-4 py-3 items-center border-border-subtle bg-surface/50";
const EYEBROW = "mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted";

function useMinuteClock(): Date {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const id = setInterval(() => setNow(new Date()), 60_000);
		return () => clearInterval(id);
	}, []);
	return now;
}

function VisitLink({ vt }: { vt: VisitTechnician }) {
	const job = vt.visit.job;
	return (
		<Link
			to={`/dispatch/jobs/${vt.visit.job_id}/visits/${vt.visit.id}`}
			className="block truncate text-sm font-medium text-text-primary transition-colors duration-150 ease-out hover:text-primary-text"
		>
			{job?.name ?? "Visit"}
			{job?.client?.name && (
				<span className="font-normal text-text-tertiary">
					{" "}
					· {job.client.name}
				</span>
			)}
		</Link>
	);
}

/**
 * Sits in the lifecycle bar's slot. A technician's status is a field mode the
 * technician sets, not a dispatcher workflow, so there is no stepper to show —
 * the dispatcher's question at this height is "what is this tech doing now".
 */
export default function TechnicianNowStrip({ technician }: { technician: Technician }) {
	const now = useMinuteClock();
	const { current, next, todayCount, todayDone } = getTechnicianActivity(technician, now);

	return (
		<section aria-label="Today" className={STRIP_CHROME}>
			{/* STRIP_CHROME is a flex row; without flex-1 the grid sizes to its
			    content and the columns bunch at the left. */}
			<div className="grid min-w-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_12rem]">
				<div className="min-w-0">
					<p className={EYEBROW}>Now</p>
					{current ? (
						<div className="flex min-w-0 items-center gap-2">
							<span
								className={`shrink-0 rounded border px-1.5 text-[11px] font-medium leading-4 ${VisitStatusColors[current.visit.status as VisitStatus]}`}
							>
								{
									VisitStatusLabels[
										current.visit
											.status as VisitStatus
									]
								}
							</span>
							<div className="min-w-0">
								<VisitLink vt={current} />
								{current.visit.actual_start_at && (
									<p className="text-xs tabular-nums text-text-tertiary">
										since{" "}
										{formatTime(
											current
												.visit
												.actual_start_at
										)}
									</p>
								)}
							</div>
						</div>
					) : (
						<p className="text-sm text-text-muted">
							Not on a visit
						</p>
					)}
				</div>
				<div className="min-w-0">
					<p className={EYEBROW}>Next</p>
					{next ? (
						<div className="min-w-0">
							<VisitLink vt={next} />
							<p className="text-xs tabular-nums text-text-tertiary">
								{formatTime(
									next.visit
										.scheduled_start_at
								)}
							</p>
						</div>
					) : (
						<p className="text-sm text-text-muted">
							Nothing else scheduled today
						</p>
					)}
				</div>
				<div>
					<p className={EYEBROW}>Today</p>
					{todayCount === 0 ? (
						<p className="text-sm text-text-muted">
							No visits today
						</p>
					) : (
						<TodayProgress
							done={todayDone}
							total={todayCount}
						/>
					)}
				</div>
			</div>
		</section>
	);
}
