import { GRACE_MS } from "./arrivalForecast.js";
import type { getScopedDb } from "./context.js";

// Read side of arrival tracking, shared by the dispatch API and the agent tools so
// the board and the assistant always tell the same story.

type ScopedDb = ReturnType<typeof getScopedDb>;

// The board: due between 4h ago and 3h ahead, plus arrivals in the last hour
const BOARD_PAST_MS = 4 * 3600_000;
const BOARD_AHEAD_MS = 3 * 3600_000;
const RECENT_ARRIVAL_MS = 3600_000;
// The tracker ticks every minute; older than this and the forecast isn't live
const STALE_FORECAST_MS = 3 * 60_000;

const STATUS_RANK = { late: 0, at_risk: 1, unknown: 2, on_time: 3, arrived: 4 } as const;

export interface ArrivalFilter {
	visitId?: string;
	techId?: string;
}

const toMin = (s: number | null) => (s === null ? null : Math.round(s / 60));

export async function listArrivals(sdb: ScopedDb, filter: ArrivalFilter = {}, now = new Date()) {
	const window = filter.visitId
		? {}
		: {
				OR: [
					{
						status: { not: "arrived" as const },
						due_at: {
							gte: new Date(now.getTime() - BOARD_PAST_MS),
							lte: new Date(now.getTime() + BOARD_AHEAD_MS),
						},
					},
					{ status: "arrived" as const, arrived_at: { gte: new Date(now.getTime() - RECENT_ARRIVAL_MS) } },
				],
			};

	const rows = await sdb.visit_tech_arrival.findMany({
		where: {
			...window,
			...(filter.visitId && { visit_id: filter.visitId }),
			...(filter.techId && { tech_id: filter.techId }),
		},
		include: {
			tech: { select: { id: true, name: true, last_ping_at: true, status: true } },
			visit: {
				select: {
					id: true,
					name: true,
					status: true,
					scheduled_start_at: true,
					arrival_constraint: true,
					job: {
						select: {
							id: true,
							job_number: true,
							name: true,
							address: true,
							client: { select: { id: true, name: true } },
						},
					},
				},
			},
		},
		take: 500,
	});

	const arrivals = rows
		.map((r) => ({
			id: r.id,
			visit_id: r.visit_id,
			visit_name: r.visit.name ?? r.visit.job.name,
			visit_status: r.visit.status,
			arrival_constraint: r.visit.arrival_constraint,
			job_id: r.visit.job.id,
			job_number: r.visit.job.job_number,
			client_id: r.visit.job.client?.id ?? null,
			client_name: r.visit.job.client?.name ?? null,
			address: r.visit.job.address,
			tech_id: r.tech.id,
			tech_name: r.tech.name,
			tech_status: r.tech.status,
			tech_last_ping_at: r.tech.last_ping_at,
			status: r.status,
			basis: r.basis,
			en_route: r.en_route,
			stop_index: r.stop_index,
			due_at: r.due_at,
			eta_at: r.eta_at,
			leave_by_at: r.leave_by_at,
			arrived_at: r.arrived_at,
			delay_minutes: toMin(r.delay_seconds),
			drive_minutes: toMin(r.drive_seconds),
			traffic_delay_minutes: toMin(r.traffic_delay_seconds),
			distance_miles: r.distance_meters === null ? null : Math.round((r.distance_meters / 1609.34) * 10) / 10,
			alerted: r.alerted_late_minutes !== null,
			computed_at: r.computed_at,
			routed_at: r.routed_at,
			stale: r.status !== "arrived" && now.getTime() - r.computed_at.getTime() > STALE_FORECAST_MS,
		}))
		.sort(
			(a, b) =>
				STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
				(b.delay_minutes ?? 0) - (a.delay_minutes ?? 0) ||
				a.due_at.getTime() - b.due_at.getTime(),
		);

	const summary = { late: 0, at_risk: 0, on_time: 0, unknown: 0, arrived: 0 };
	for (const a of arrivals) summary[a.status]++;

	return { as_of: now, summary, arrivals };
}

export type ArrivalView = Awaited<ReturnType<typeof listArrivals>>["arrivals"][number];

/** On-time record for arrivals in [start, end): what the tracker saw actually happen. */
export async function onTimePerformance(
	sdb: ScopedDb,
	range: { start: Date; end: Date },
	techId?: string,
) {
	const rows = await sdb.visit_tech_arrival.findMany({
		where: {
			status: "arrived",
			arrived_at: { gte: range.start, lt: range.end },
			...(techId && { tech_id: techId }),
		},
		select: { delay_seconds: true, tech: { select: { id: true, name: true } } },
	});

	const graceSeconds = GRACE_MS / 1000;
	const byTech = new Map<string, { tech_id: string; tech_name: string; arrivals: number; on_time: number; late_minutes: number[] }>();
	for (const r of rows) {
		const t = byTech.get(r.tech.id) ?? { tech_id: r.tech.id, tech_name: r.tech.name, arrivals: 0, on_time: 0, late_minutes: [] };
		t.arrivals++;
		if ((r.delay_seconds ?? 0) <= graceSeconds) t.on_time++;
		else t.late_minutes.push(Math.round((r.delay_seconds ?? 0) / 60));
		byTech.set(r.tech.id, t);
	}

	const rate = (on: number, n: number) => (n === 0 ? null : Math.round((on / n) * 1000) / 10);
	const techs = [...byTech.values()]
		.map((t) => ({
			tech_id: t.tech_id,
			tech_name: t.tech_name,
			arrivals: t.arrivals,
			on_time: t.on_time,
			late: t.late_minutes.length,
			on_time_rate_pct: rate(t.on_time, t.arrivals),
			avg_minutes_late_when_late: t.late_minutes.length
				? Math.round(t.late_minutes.reduce((a, b) => a + b, 0) / t.late_minutes.length)
				: null,
		}))
		.sort((a, b) => (a.on_time_rate_pct ?? 100) - (b.on_time_rate_pct ?? 100));

	const total = rows.length;
	const onTime = techs.reduce((n, t) => n + t.on_time, 0);
	return {
		grace_minutes: graceSeconds / 60,
		arrivals: total,
		on_time: onTime,
		on_time_rate_pct: rate(onTime, total),
		technicians: techs,
	};
}
