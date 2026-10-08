import { useMemo, useState } from "react";
import RecordMap from "../ui/maps/RecordMap";
import type { RailVisit } from "../ui/maps/RecordMapRail";
import { defaultSelectedVisitIds } from "../../lib/jobMapVisits";
import { useAuthStore } from "../../auth/authStore";
import { FALLBACK_TIMEZONE } from "../../util/util";
import type { Job, JobVisit } from "../../types/jobs";

const byStart = (a: JobVisit, b: JobVisit) =>
	new Date(a.scheduled_start_at).getTime() - new Date(b.scheduled_start_at).getTime();

export default function JobMapTab({ job, visits }: { job: Job; visits: JobVisit[] }) {
	const { user } = useAuthStore();
	const tz = user?.orgTimezone ?? FALLBACK_TIMEZONE;
	// null = the dispatcher hasn't touched the picker, so the selection keeps
	// tracking the default as visits load and change status.
	const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);

	const sorted = useMemo(() => [...visits].sort(byStart), [visits]);
	const selected = useMemo(
		() => picked ?? new Set(defaultSelectedVisitIds(visits, new Date())),
		[picked, visits],
	);

	const toggle = (visitId: string) => {
		const next = new Set(selected);
		if (next.has(visitId)) next.delete(visitId);
		else next.add(visitId);
		setPicked(next);
	};

	const chosen = sorted.filter((v) => selected.has(v.id));
	const techIds = [...new Set(chosen.flatMap((v) => v.visit_techs.map((vt) => vt.tech_id)))];

	// Date order, never active-first: rows must not jump while the dispatcher toggles them.
	const railVisits: RailVisit[] = sorted.map((v) => ({
		id: v.id,
		startAt: v.scheduled_start_at,
		name: v.name ?? "",
		status: v.status,
		selected: selected.has(v.id),
		crewCount: v.visit_techs.length,
	}));

	return (
		<RecordMap
			site={{ coords: job.coords, label: job.client?.name ?? job.name }}
			address={job.address}
			techIds={techIds}
			focusVisitIds={chosen.map((v) => v.id)}
			visits={railVisits}
			onToggleVisit={toggle}
			tz={tz}
			emptyTechText={
				visits.length > 0 && chosen.length === 0 ? "Select a visit to see its crew" : undefined
			}
		/>
	);
}
