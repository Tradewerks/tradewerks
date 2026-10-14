import * as notificationsController from "../controllers/notificationsController.js";
import { db } from "../db.js";
import {
	arrivalDueAt,
	decideAlert,
	forecastRoute,
	STALE_PING_MS,
	type AlertAction,
	type Forecast,
	type ForecastLeg,
	type ForecastStop,
} from "../lib/arrivalForecast.js";
import { fetchTrafficLegs, MAX_ROUTE_STOPS, toLatLon, type LatLon } from "../lib/mapboxDirections.js";
import { log } from "./appLogger.js";
import { emitToOrg } from "./socketService.js";

// Every minute, forecast each working tech's arrival at the visits queued for them in
// the next few hours, persist it to visit_tech_arrival and alert dispatch on changes.
// Mapbox is only asked for a fresh traffic route on a cadence; between routes the
// cached leg times roll forward, so a tech who hasn't left keeps losing slack.

const TICK_MS = 60_000;
const LOOKAHEAD_MS = 3 * 3600_000;
// Never-started visits drop off the board this long after they were due
const STALE_DUE_MS = 2 * 3600_000;
const DAY_MS = 24 * 3600_000;
const ROUTE_EN_ROUTE_MS = 2 * 60_000;
const ROUTE_IDLE_MS = 5 * 60_000;
// Directions allows 300 req/min; leave headroom for the map and mileage
const MAX_ROUTES_PER_TICK = 100;

const PENDING_TECH = ["Assigned", "EnRoute"] as const;
const WORKING_VISIT = ["OnSite", "InProgress", "Paused"];

type Candidate = Awaited<ReturnType<typeof loadCandidates>>[number];
type ArrivalRow = Awaited<ReturnType<typeof loadRows>>[number];

function loadCandidates(now: Date) {
	return db.job_visit_technician.findMany({
		where: {
			tech_status: { in: [...PENDING_TECH, "OnSite"] },
			tech: { deactivated_at: null },
			visit: {
				status: { notIn: ["Completed", "Cancelled"] },
				scheduled_start_at: {
					gte: new Date(now.getTime() - STALE_DUE_MS - DAY_MS),
					lte: new Date(now.getTime() + LOOKAHEAD_MS + DAY_MS),
				},
			},
		},
		select: {
			tech_id: true,
			tech_status: true,
			tech: { select: { name: true, coords: true, last_ping_at: true } },
			visit: {
				select: {
					id: true,
					status: true,
					arrival_constraint: true,
					arrival_time: true,
					arrival_window_end: true,
					scheduled_start_at: true,
					scheduled_end_at: true,
					job: {
						select: {
							id: true,
							job_number: true,
							coords: true,
							organization_id: true,
							organization: { select: { timezone: true } },
							client: { select: { name: true } },
						},
					},
				},
			},
		},
	});
}

function loadRows(now: Date, visitIds: string[]) {
	return db.visit_tech_arrival.findMany({
		where: {
			OR: [
				{ visit_id: { in: visitIds } },
				{ status: { not: "arrived" }, due_at: { gte: new Date(now.getTime() - DAY_MS) } },
			],
		},
	});
}

const key = (visitId: string, techId: string) => `${visitId}:${techId}`;

interface Stop {
	c: Candidate;
	dueAt: Date;
	coords: LatLon | null;
}

let running = false;

export function startArrivalTrackingInterval(): void {
	setInterval(async () => {
		if (running) return; // a slow Mapbox tick must not overlap the next
		running = true;
		try {
			await runArrivalTick(new Date());
		} catch (e) {
			log.error({ err: e }, "Arrival tracking tick failed");
		} finally {
			running = false;
		}
	}, TICK_MS);
}

export async function runArrivalTick(now: Date): Promise<void> {
	const candidates = await loadCandidates(now);

	// Group by tech: a tech's queue has to be forecast as one route
	const byTech = new Map<string, Candidate[]>();
	for (const c of candidates) {
		if (!c.visit.job.organization_id) continue;
		const list = byTech.get(c.tech_id) ?? [];
		list.push(c);
		byTech.set(c.tech_id, list);
	}

	const queues = new Map<string, { anchor: Candidate | null; stops: Stop[] }>();
	for (const [techId, list] of byTech) {
		const anchor =
			list
				.filter((c) => c.tech_status === "OnSite" && WORKING_VISIT.includes(c.visit.status))
				.sort((a, b) => b.visit.scheduled_start_at.getTime() - a.visit.scheduled_start_at.getTime())[0] ??
			null;
		const stops = list
			.filter((c) => (PENDING_TECH as readonly string[]).includes(c.tech_status))
			.map((c) => ({
				c,
				dueAt: arrivalDueAt(c.visit, c.visit.job.organization?.timezone ?? "UTC"),
				coords: toLatLon(c.visit.job.coords),
			}))
			.filter((s) => {
				const due = s.dueAt.getTime();
				return due <= now.getTime() + LOOKAHEAD_MS && due >= now.getTime() - STALE_DUE_MS;
			})
			// Whatever they're driving to is next, then the schedule
			.sort(
				(a, b) =>
					Number(b.c.tech_status === "EnRoute") - Number(a.c.tech_status === "EnRoute") ||
					a.c.visit.scheduled_start_at.getTime() - b.c.visit.scheduled_start_at.getTime() ||
					a.dueAt.getTime() - b.dueAt.getTime(),
			)
			.slice(0, MAX_ROUTE_STOPS - 1);
		if (stops.length) queues.set(techId, { anchor, stops });
	}

	const pendingVisitIds = [...queues.values()].flatMap((q) => q.stops.map((s) => s.c.visit.id));
	const rows = await loadRows(now, pendingVisitIds);
	const rowByKey = new Map(rows.map((r) => [key(r.visit_id, r.tech_id), r]));

	// Stalest routes first, so a capped tick still gets to everyone in turn
	const order = [...queues.entries()].sort(
		([, a], [, b]) => oldestRoute(a.stops, rowByKey) - oldestRoute(b.stops, rowByKey),
	);

	const touchedOrgs = new Set<string>();
	const tracked = new Set<string>();
	let routesLeft = MAX_ROUTES_PER_TICK;

	for (const [techId, queue] of order) {
		for (const s of queue.stops) tracked.add(key(s.c.visit.id, techId));
		try {
			const usedRoute = await forecastTech(now, techId, queue, rowByKey, routesLeft > 0);
			if (usedRoute) routesLeft--;
			touchedOrgs.add(queue.stops[0].c.visit.job.organization_id!);
		} catch (e) {
			log.error({ err: e, techId }, "Arrival forecast failed for tech");
		}
	}

	// Rows that dropped out of the queue: arrived, unassigned, cancelled, or stale
	const orphans = rows.filter((r) => r.status !== "arrived" && !tracked.has(key(r.visit_id, r.tech_id)));
	for (const row of orphans) {
		try {
			if (await settleOrphan(row)) touchedOrgs.add(row.organization_id);
		} catch (e) {
			log.error({ err: e, visitId: row.visit_id, techId: row.tech_id }, "Arrival settle failed");
		}
	}

	for (const orgId of touchedOrgs) {
		try {
			emitToOrg(orgId, "arrivals:updated", { organizationId: orgId });
		} catch {
			// best-effort push; the board also polls
		}
	}
}

function oldestRoute(stops: Stop[], rowByKey: Map<string, ArrivalRow>): number {
	let oldest = Infinity;
	for (const s of stops) {
		const r = rowByKey.get(key(s.c.visit.id, s.c.tech_id));
		oldest = Math.min(oldest, r?.routed_at?.getTime() ?? 0);
	}
	return oldest;
}

// Returns whether a Mapbox route was requested
async function forecastTech(
	now: Date,
	techId: string,
	queue: { anchor: Candidate | null; stops: Stop[] },
	rowByKey: Map<string, ArrivalRow>,
	mayRoute: boolean,
): Promise<boolean> {
	const { anchor } = queue;
	// A visit already past due that they aren't driving to can't be placed on the
	// route: it's reported on its own, so a forgotten morning visit doesn't push the
	// whole afternoon hours late
	const overdue = queue.stops.filter(
		(s) => s.dueAt.getTime() < now.getTime() && s.c.tech_status !== "EnRoute",
	);
	const stops = queue.stops.filter((s) => !overdue.includes(s));
	const firstEnRoute = stops[0]?.c.tech_status === "EnRoute";
	const tech = queue.stops[0].c.tech;
	const freshPing =
		tech.last_ping_at && now.getTime() - tech.last_ping_at.getTime() <= STALE_PING_MS
			? toLatLon(tech.coords)
			: null;

	// Driving: from the truck. Working a visit: from that job once it's done. Otherwise
	// from the truck if we have a recent fix.
	const origin = firstEnRoute
		? freshPing
		: anchor
			? (toLatLon(anchor.visit.job.coords) ?? freshPing)
			: freshPing;
	const availableAt = !firstEnRoute && anchor ? anchor.visit.scheduled_end_at : now;

	// Route through the prefix of stops we can place on a map
	const routable: LatLon[] = [];
	if (origin) {
		routable.push(origin);
		for (const s of stops) {
			if (!s.coords) break;
			routable.push(s.coords);
		}
	}

	const existing = stops.map((s) => rowByKey.get(key(s.c.visit.id, techId)));
	const cadence = firstEnRoute ? ROUTE_EN_ROUTE_MS : ROUTE_IDLE_MS;
	const stale = existing.slice(0, routable.length - 1).some(
		(r, i) =>
			!r ||
			!r.routed_at ||
			r.stop_index !== i ||
			r.en_route !== (stops[i].c.tech_status === "EnRoute") ||
			now.getTime() - r.routed_at.getTime() >= cadence,
	);

	let legs: Array<ForecastLeg | null> = stops.map((_, i) => cachedLeg(existing[i], i));
	let routedAt: Date | null = existing[0]?.routed_at ?? null;
	let requested = false;
	if (stale && mayRoute && routable.length >= 2) {
		requested = true;
		const fresh = await fetchTrafficLegs(routable);
		if (fresh) {
			legs = stops.map((_, i) => fresh[i] ?? null);
			routedAt = now;
		}
	}
	// No way to reach the first stop means no chain at all
	if (!origin) legs = stops.map(() => null);

	const toForecastStop = (s: Stop): ForecastStop => ({
		visitId: s.c.visit.id,
		dueAt: s.dueAt,
		enRoute: s.c.tech_status === "EnRoute",
		scheduledStartAt: s.c.visit.scheduled_start_at,
		plannedMs: Math.max(0, s.c.visit.scheduled_end_at.getTime() - s.c.visit.scheduled_start_at.getTime()),
		hasCoords: !!s.coords,
	});
	const forecasts = forecastRoute({
		now,
		availableAt,
		legs,
		stops: stops.map(toForecastStop),
		enRouteMeasuredAt: firstEnRoute ? routedAt : null,
	});
	const overdueForecasts = forecastRoute({
		now,
		availableAt: now,
		legs: overdue.map(() => null),
		stops: overdue.map(toForecastStop),
		enRouteMeasuredAt: null,
	});

	const entries = [
		...stops.map((s, i) => ({ s, f: forecasts[i], prev: existing[i] })),
		...overdue.map((s, i) => ({
			s,
			f: { ...overdueForecasts[i], stopIndex: 0 },
			prev: rowByKey.get(key(s.c.visit.id, techId)),
		})),
	];
	for (const { s, f, prev } of entries) {
		const orgId = s.c.visit.job.organization_id!;
		const action = decideAlert(f, prev?.alerted_late_minutes ?? null);

		const alertFields =
			action === "late" || action === "worse"
				? { alerted_late_minutes: Math.round((f.delaySeconds ?? 0) / 60), alerted_at: now }
				: action === "recovered"
					? { alerted_late_minutes: null, alerted_at: now }
					: {};
		const data = {
			status: f.status,
			basis: f.basis,
			en_route: s.c.tech_status === "EnRoute",
			stop_index: f.stopIndex,
			due_at: f.dueAt,
			eta_at: f.etaAt,
			leave_by_at: f.leaveByAt,
			delay_seconds: f.delaySeconds,
			drive_seconds: f.driveSeconds,
			traffic_delay_seconds: f.trafficDelaySeconds,
			distance_meters: f.distanceMeters,
			computed_at: now,
			// A leg we couldn't recompute keeps its old timestamp so it's retried first
			routed_at: f.basis === "traffic" ? routedAt : (prev?.routed_at ?? null),
			arrived_at: null,
			...alertFields,
		};
		await db.visit_tech_arrival.upsert({
			where: { visit_id_tech_id: { visit_id: s.c.visit.id, tech_id: techId } },
			create: { ...data, organization_id: orgId, visit_id: s.c.visit.id, tech_id: techId },
			update: data,
		});

		if (action) await sendAlert(action, s, f, techId, orgId);
	}
	return requested;
}

function cachedLeg(row: ArrivalRow | undefined, index: number): ForecastLeg | null {
	if (!row || row.stop_index !== index || row.drive_seconds === null) return null;
	return {
		durationSeconds: row.drive_seconds,
		typicalSeconds: row.traffic_delay_seconds === null ? null : row.drive_seconds - row.traffic_delay_seconds,
		distanceMeters: row.distance_meters ?? 0,
	};
}

// Returns whether the row changed
async function settleOrphan(row: ArrivalRow): Promise<boolean> {
	const assignment = await db.job_visit_technician.findUnique({
		where: { visit_id_tech_id: { visit_id: row.visit_id, tech_id: row.tech_id } },
		select: { tech_status: true, visit: { select: { status: true } } },
	});

	if (!assignment || assignment.visit.status === "Cancelled") {
		await db.visit_tech_arrival.delete({ where: { id: row.id } });
		return true;
	}
	if (assignment.tech_status !== "OnSite" && assignment.tech_status !== "Done") return false;

	// The drive ending is the arrival; without one, the first clock-in
	const [drive, entry] = await Promise.all([
		db.visit_tech_drive.findFirst({
			where: { visit_id: row.visit_id, tech_id: row.tech_id, ended_at: { not: null } },
			orderBy: { ended_at: "desc" },
			select: { ended_at: true },
		}),
		db.visit_tech_time_entry.findFirst({
			where: { visit_id: row.visit_id, tech_id: row.tech_id },
			orderBy: { clocked_in_at: "asc" },
			select: { clocked_in_at: true },
		}),
	]);
	const arrivedAt = drive?.ended_at ?? entry?.clocked_in_at ?? new Date();
	await db.visit_tech_arrival.update({
		where: { id: row.id },
		data: {
			status: "arrived",
			basis: "actual",
			arrived_at: arrivedAt,
			eta_at: arrivedAt,
			delay_seconds: Math.round((arrivedAt.getTime() - row.due_at.getTime()) / 1000),
			en_route: false,
			leave_by_at: null,
			computed_at: new Date(),
			alerted_late_minutes: null,
		},
	});
	return true;
}

// ── Alerts ───────────────────────────────────────────────────────────────────

async function sendAlert(action: Exclude<AlertAction, null>, s: Stop, f: Forecast, techId: string, orgId: string) {
	const tz = s.c.visit.job.organization?.timezone ?? "UTC";
	const fmt = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
	const client = s.c.visit.job.client.name;
	const techName = s.c.tech.name;
	const lateMin = Math.max(1, Math.round((f.delaySeconds ?? 0) / 60));
	const due = fmt(f.dueAt);
	const enRoute = s.c.tech_status === "EnRoute";
	const traffic =
		f.trafficDelaySeconds !== null && f.trafficDelaySeconds >= 5 * 60
			? ` Traffic is adding ~${Math.round(f.trafficDelaySeconds / 60)} min.`
			: "";

	let situation: string;
	if (action === "recovered") {
		situation = `ETA ${fmt(f.etaAt!)}, due by ${due}.`;
	} else if (f.basis === "elapsed") {
		situation = `Was due by ${due} and hasn't arrived (~${lateMin} min late).`;
	} else if (enRoute) {
		situation = `ETA ${fmt(f.etaAt!)}, due by ${due} (~${lateMin} min late).${traffic}`;
	} else if (f.stopIndex > 0) {
		situation = `After finishing earlier work, ETA ${fmt(f.etaAt!)}; due by ${due} (~${lateMin} min late).${traffic}`;
	} else {
		situation = `Hasn't left yet. ~${Math.round((f.driveSeconds ?? 0) / 60)} min drive in current traffic; due by ${due} (~${lateMin} min late).${traffic}`;
	}

	const title =
		action === "recovered"
			? `${techName} back on track — ${client}`
			: action === "worse"
				? `${techName} now ~${lateMin} min late — ${client}`
				: `${techName} running late — ${client}`;

	await notificationsController.notifyDispatchers(
		{
			type: "tech_running_late",
			title,
			body: `Job ${s.c.visit.job.job_number}. ${situation}`,
			actionUrl: `/dispatch/jobs/${s.c.visit.job.id}/visits/${s.c.visit.id}`,
		},
		orgId,
	);

	// The tech hears once, when it first goes late; dispatch owns the follow-up
	if (action === "late") {
		const techBody =
			f.basis === "elapsed"
				? `Was due by ${due}.`
				: enRoute
					? `ETA ${fmt(f.etaAt!)}, due by ${due} (~${lateMin} min late).${traffic}`
					: `~${Math.round((f.driveSeconds ?? 0) / 60)} min drive in current traffic; due by ${due}.${traffic}`;
		await notificationsController.createNotification(
			{
				technicianId: techId,
				type: "tech_running_late",
				title: f.basis === "elapsed" ? `You're late to ${client}` : `You may be late to ${client}`,
				body: techBody,
				actionUrl: `/technician/visits/${s.c.visit.id}`,
			},
			orgId,
		);
	}
}
