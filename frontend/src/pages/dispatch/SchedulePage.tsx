import ScheduleBoard from "../../components/ui/schedule/ScheduleBoard";
import { useAllJobsQuery } from "../../hooks/useJobs";
import { useActiveTechniciansQuery } from "../../hooks/useTechnicians";

export default function SchedulePage() {
	const { data: jobs = [], error: jobsError } = useAllJobsQuery();
	const { data: technicians = [], error: techsError } = useActiveTechniciansQuery();

	return (
		<div className="h-[calc(100%+2rem)] md:h-[calc(100%+3rem)] overflow-hidden -m-4 md:-m-6">
			{(jobsError || techsError) && (
				<p className="text-error-text px-6 py-2 text-sm">Failed to load schedule data.</p>
			)}
			<ScheduleBoard jobs={jobs} technicians={technicians} />
		</div>
	);
}
