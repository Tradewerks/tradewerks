import type { Arrival } from "../../types/arrivals";
import { formatTime } from "../../util/util";
import ArrivalStatusBadge from "./ArrivalStatusBadge";
import { ARRIVAL_STATUS_META, describeSituation, formatDelay } from "./arrivalPresentation";

interface ArrivalRowProps {
	arrival: Arrival;
	tz: string;
	now: number;
	onOpen: () => void;
}

// One tech heading to one visit, dense enough to scan a dozen at a glance
export default function ArrivalRow({ arrival: a, tz, now, onOpen }: ArrivalRowProps) {
	const delay = formatDelay(a);
	const meta = ARRIVAL_STATUS_META[a.status];
	const time = a.status === "arrived" ? a.arrived_at : a.eta_at;

	return (
		<li>
			<button
				type="button"
				onClick={onOpen}
				className="w-full text-left grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 px-4 py-2.5 hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none transition-colors duration-150"
			>
				<div className="flex items-center gap-2 min-w-0">
					<ArrivalStatusBadge status={a.status} />
					<span className="text-sm font-medium text-text-primary truncate">{a.tech_name}</span>
				</div>
				<div className="text-right text-sm tabular-nums text-text-primary whitespace-nowrap">
					{time ? (
						<>
							<span className="text-text-muted text-xs mr-1">{a.status === "arrived" ? "at" : "ETA"}</span>
							{formatTime(time, tz)}
						</>
					) : (
						<span className="text-text-muted">—</span>
					)}
				</div>

				<div className="flex text-xs min-w-0">
					<span className="text-text-secondary truncate">{a.client_name ?? a.visit_name}</span>
					<span className="text-text-muted shrink-0 whitespace-pre"> · {a.job_number}</span>
				</div>
				<div className="text-right text-xs tabular-nums whitespace-nowrap">
					<span className="text-text-muted">due {formatTime(a.due_at, tz)}</span>
					{delay && <span className={`ml-1.5 font-medium ${meta.text}`}>{delay}</span>}
				</div>

				<div className="col-span-2 text-xs text-text-muted truncate">
					{describeSituation(a, tz, now)}
					{a.stale && <span className="text-warning-text"> · not updated recently</span>}
				</div>
			</button>
		</li>
	);
}
