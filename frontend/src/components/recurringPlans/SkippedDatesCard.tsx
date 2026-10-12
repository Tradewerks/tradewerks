import { useSkippedDatesQuery } from "../../hooks/useRecurringPlans";
import Card from "../ui/Card";

const fmt = (iso: string) =>
	new Date(iso).toLocaleDateString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
	});

export default function SkippedDatesCard({ jobId }: { jobId: string | undefined }) {
	const { data: dates = [] } = useSkippedDatesQuery(jobId);
	if (dates.length === 0) return null;
	return (
		<Card title="Skipped Dates">
			<p className="text-xs text-text-muted">
				Recurring Plans was off on these dates. No visit was created for them and
				none will be. Schedule a visit by hand if one is still needed.
			</p>
			<ul className="mt-3 flex flex-wrap gap-1.5">
				{dates.map((d) => (
					<li
						key={d}
						className="rounded border border-border px-2 py-0.5 text-xs text-text-secondary"
					>
						{fmt(d)}
					</li>
				))}
			</ul>
		</Card>
	);
}
