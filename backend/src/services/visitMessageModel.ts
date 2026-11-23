import type { getScopedDb } from "../lib/context.js";
import { localTimeOnDay } from "../lib/dayRange.js";
import {
	formatArrivalWindow,
	formatLocalDate,
	formatLocalTime,
} from "../lib/formatLocal.js";

type ScopedDb = ReturnType<typeof getScopedDb>;

export interface VisitModel {
	visit: {
		date: string;
		window: string;
		address: string;
		job_title: string;
		name: string;
		description: string;
		tech_names: string;
		tech_first_name: string;
		eta: string;
	};
	tech: { name: string; title: string };
	status: string;
	tech_first_names: string[];
	/** Raw storage URL of the named tech's photo; sign before it leaves the server. */
	tech_photo_raw_url: string | null;
}

const firstName = (full: string) => full.trim().split(/\s+/)[0] ?? "";

function joinNames(names: string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Null when the visit isn't in the scoped org. */
export async function buildVisitModel(
	sdb: ScopedDb,
	visitId: string,
	tz: string,
): Promise<VisitModel | null> {
	const now = new Date();
	const dayStart = localTimeOnDay(now, "00:00", tz);
	const v = await sdb.job_visit.findFirst({
		where: { id: visitId },
		include: {
			job: { select: { name: true, address: true } },
			visit_techs: {
				include: {
					tech: {
						select: { name: true, title: true, photo_url: true },
					},
				},
			},
			arrivals: {
				select: {
					tech_id: true,
					basis: true,
					eta_at: true,
					computed_at: true,
				},
			},
			drives: {
				where: { started_at: { gte: dayStart } },
				orderBy: { started_at: "asc" },
				select: { tech_id: true, started_at: true },
			},
		},
	});
	if (!v) return null;
	// The outbox row can't carry who drove, so name whoever started driving
	// first today; status only covers visits with no recorded drive.
	const firstDrive = v.drives[0];
	const driver =
		v.visit_techs.find((t) => t.tech_id === firstDrive?.tech_id) ??
		v.visit_techs.find((t) => t.tech_status === "EnRoute") ??
		v.visit_techs.find((t) => t.tech_status === "OnSite") ??
		v.visit_techs[0];
	const arrival = driver
		? v.arrivals.find((a) => a.tech_id === driver.tech_id)
		: undefined;
	// A forecast computed before the drive began, or already in the past, is
	// not an estimate worth promising.
	const fresh =
		arrival?.eta_at &&
		arrival.basis !== "no_location" &&
		arrival.eta_at > now &&
		(!firstDrive || arrival.computed_at >= firstDrive.started_at);
	const eta =
		fresh && arrival?.eta_at ? formatLocalTime(arrival.eta_at, tz) : "";
	const names = v.visit_techs
		.map((t) => firstName(t.tech.name))
		.filter(Boolean);
	return {
		visit: {
			date: formatLocalDate(v.scheduled_start_at, tz),
			window: formatArrivalWindow(v, tz),
			address: v.job.address,
			job_title: v.job.name,
			name: v.name ?? "",
			description: v.description ?? "",
			tech_names: joinNames(names),
			tech_first_name: names[0] ?? "",
			eta,
		},
		tech: {
			name: driver?.tech.name ?? "",
			title: driver?.tech.title ?? "",
		},
		status: v.status,
		tech_first_names: names,
		tech_photo_raw_url: driver?.tech.photo_url ?? null,
	};
}
