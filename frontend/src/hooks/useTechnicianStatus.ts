// frontend/src/hooks/useTechnicianStatus.ts
import { useOwnVisitsQuery } from "./useJobs";
import type { TechnicianStatus } from "../lib/visitActionConstraints";

export function useTechnicianStatus(techId: string): TechnicianStatus {
	// techId is always the signed-in technician (technician screens only); the bounded
	// /assigned read also carries their stale active and open-clock visits.
	const { data: visits = [] } = useOwnVisitsQuery(techId);
	// empty techId: query is disabled via enabled:!!techId, visits defaults to []

	const drivingVisit = visits.find((v) => v.status === "Driving");

	const clockedInVisit = visits.find((v) =>
		v.time_entries?.some((e) => e.tech_id === techId && e.clocked_out_at === null),
	);

	return {
		isClockedIn: clockedInVisit != null,
		clockedInVisitId: clockedInVisit?.id ?? null,
		isDriving: drivingVisit != null,
		drivingVisitId: drivingVisit?.id ?? null,
	};
}
