import { useNavigate } from "react-router-dom";
import { Navigation } from "lucide-react";
import Card from "../ui/Card";
import { useAuthStore } from "../../auth/authStore";
import { useArrivalBoardQuery } from "../../hooks/useArrivals";
import { useNow } from "../../hooks/useNow";
import { FALLBACK_TIMEZONE } from "../../util/util";
import ArrivalRow from "../arrivals/ArrivalRow";
import { arrivalVisitPath } from "../arrivals/arrivalPresentation";

// Live on-time board: every tech heading to a visit in the next three hours,
// worst first. Fed by the backend arrival tracker (Mapbox live traffic).
export default function LiveArrivalsWidget() {
	const navigate = useNavigate();
	const tz = useAuthStore((s) => s.user?.orgTimezone) ?? FALLBACK_TIMEZONE;
	const now = useNow(30_000);
	const { data, isLoading, isError } = useArrivalBoardQuery();

	const arrivals = data?.arrivals ?? [];
	const summary = data?.summary;

	return (
		<Card
			title="Arrivals"
			className="h-full"
			scrollable
			flush
			headerAction={
				summary && arrivals.length > 0 ? (
					<span className="text-xs text-text-muted tabular-nums">
						{summary.late > 0 && <span className="text-error-text font-medium">{summary.late} late · </span>}
						{summary.at_risk > 0 && (
							<span className="text-warning-text font-medium">{summary.at_risk} at risk · </span>
						)}
						{arrivals.length - summary.arrived} tracking
					</span>
				) : undefined
			}
		>
			{isLoading ? (
				<p className="px-4 py-6 text-sm text-text-muted">Loading arrivals…</p>
			) : isError ? (
				<p className="px-4 py-6 text-sm text-error-text">Couldn't load arrival forecasts.</p>
			) : arrivals.length === 0 ? (
				<div className="flex flex-col items-center justify-center h-full text-center px-4 py-6">
					<div className="w-10 h-10 rounded-full bg-primary-bg flex items-center justify-center mb-3">
						<Navigation size={18} className="text-primary-text" aria-hidden="true" />
					</div>
					<p className="text-text-secondary text-xs font-medium">No arrivals in the next 3 hours</p>
					<p className="text-text-muted text-xs mt-1">
						Assigned visits show here with a live traffic ETA.
					</p>
				</div>
			) : (
				<ul className="divide-y divide-border-subtle" aria-label="Technician arrivals">
					{arrivals.map((a) => (
						<ArrivalRow
							key={a.id}
							arrival={a}
							tz={tz}
							now={now}
							onOpen={() => navigate(arrivalVisitPath(a))}
						/>
					))}
				</ul>
			)}
		</Card>
	);
}
