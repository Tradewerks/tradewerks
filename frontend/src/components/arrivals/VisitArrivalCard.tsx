import Card from "../ui/Card";
import { useAuthStore } from "../../auth/authStore";
import { useVisitArrivalsQuery } from "../../hooks/useArrivals";
import { useNow } from "../../hooks/useNow";
import { FALLBACK_TIMEZONE, formatTime } from "../../util/util";
import ArrivalStatusBadge from "./ArrivalStatusBadge";
import ArrivalTrack from "./ArrivalTrack";
import { ARRIVAL_STATUS_META, describeSituation, formatDelay } from "./arrivalPresentation";

function ago(iso: string, now: number): string {
	const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
	if (s < 60) return "just now";
	const m = Math.round(s / 60);
	return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

// Per-tech arrival forecast on the visit page. Renders nothing until the tracker
// has picked the visit up (assigned, due within three hours).
export default function VisitArrivalCard({ visitId }: { visitId: string }) {
	const tz = useAuthStore((s) => s.user?.orgTimezone) ?? FALLBACK_TIMEZONE;
	const now = useNow(30_000);
	const { data } = useVisitArrivalsQuery(visitId);
	const arrivals = data?.arrivals ?? [];
	if (arrivals.length === 0) return null;

	const newest = arrivals.reduce((t, a) => Math.max(t, new Date(a.computed_at).getTime()), 0);

	return (
		<Card
			title="Arrival"
			headerAction={
				<span className="text-xs text-text-muted">
					Live traffic · updated {ago(new Date(newest).toISOString(), now)}
				</span>
			}
		>
			<ul className="flex flex-col gap-4">
				{arrivals.map((a) => {
					const delay = formatDelay(a);
					return (
						<li key={a.id} className="flex flex-col gap-1">
							<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
								<ArrivalStatusBadge status={a.status} size="md" />
								<span className="font-medium text-text-primary">{a.tech_name}</span>
								<span className="ml-auto text-sm tabular-nums text-text-secondary">
									{a.status === "arrived" ? (
										<>Arrived {a.arrived_at ? formatTime(a.arrived_at, tz) : ""}</>
									) : a.eta_at ? (
										<>
											ETA <span className="font-semibold text-text-primary">{formatTime(a.eta_at, tz)}</span>
										</>
									) : (
										"ETA unavailable"
									)}
									<span className="text-text-muted"> · due {formatTime(a.due_at, tz)}</span>
									{delay && (
										<span className={`ml-1.5 font-medium ${ARRIVAL_STATUS_META[a.status].text}`}>
											{delay}
										</span>
									)}
								</span>
							</div>
							<p className="text-xs text-text-muted">
								{describeSituation(a, tz, now)}
								{a.stop_index > 0 && " (assumes earlier visits finish on schedule)"}
								{a.stale && <span className="text-warning-text"> · not updated recently</span>}
							</p>
							<ArrivalTrack arrival={a} tz={tz} now={now} />
						</li>
					);
				})}
			</ul>
		</Card>
	);
}
