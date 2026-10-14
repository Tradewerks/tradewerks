import type { Arrival } from "../../types/arrivals";
import { formatTime } from "../../util/util";
import { ARRIVAL_STATUS_META } from "./arrivalPresentation";

interface ArrivalTrackProps {
	arrival: Arrival;
	tz: string;
	now: number;
}

/**
 * Now → ETA against the due time, on one axis. The bar is how far off the tech is;
 * the tick is the promise. A bar that runs past the tick is the whole story.
 */
export default function ArrivalTrack({ arrival, tz, now }: ArrivalTrackProps) {
	if (!arrival.eta_at || arrival.status === "arrived") return null;
	const due = new Date(arrival.due_at).getTime();
	const eta = new Date(arrival.eta_at).getTime();
	const end = Math.max(due, eta, now + 60_000);
	const span = (end - now) * 1.08;
	const pct = (t: number) => Math.min(100, Math.max(0, ((t - now) / span) * 100));
	const meta = ARRIVAL_STATUS_META[arrival.status];
	const dueLeft = pct(due);

	return (
		<div className="pt-5 pb-1" aria-hidden="true">
			<div className="relative h-2 rounded-full bg-surface-inset">
				<div
					className={`absolute inset-y-0 left-0 rounded-full ${meta.fill} motion-safe:transition-[width] motion-safe:duration-500`}
					style={{ width: `${pct(eta)}%` }}
				/>
				<div
					className="absolute -top-1 -bottom-1 w-0.5 bg-text-primary rounded-full"
					style={{ left: `calc(${dueLeft}% - 1px)` }}
				/>
				<span
					className="absolute -top-5 text-[11px] font-medium text-text-secondary whitespace-nowrap tabular-nums"
					style={
						dueLeft > 70
							? { right: `${100 - dueLeft}%` }
							: { left: `${dueLeft}%`, transform: "translateX(-50%)" }
					}
				>
					Due {formatTime(arrival.due_at, tz)}
				</span>
			</div>
			<div className="flex justify-between mt-1 text-[11px] text-text-muted tabular-nums">
				<span>Now</span>
				<span>ETA {formatTime(arrival.eta_at, tz)}</span>
			</div>
		</div>
	);
}
