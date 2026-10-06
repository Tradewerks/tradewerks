import { useSkippedDatesQuery } from "../../hooks/useRecurringPlans";

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
		<section className="mt-4 rounded-xl border border-border-subtle bg-base p-4">
			<h3 className="text-sm font-semibold text-text-primary">
				Dates skipped while Recurring Plans was off
			</h3>
			<p className="mt-0.5 text-xs text-text-muted">
				No visit was created for these dates and none will be. Schedule a
				visit by hand if one is still needed.
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
		</section>
	);
}
