import { Router } from "express";
import * as api from "../services/backendApi.js";
import { getDirections } from "../services/mapboxService.js";
import { simulation } from "../sim/simulationManager.js";
import { config } from "../config.js";
import type { DemoScenario } from "../operators/technician.js";
import type { Coordinates } from "../types/location.js";

// Stage a drive the backend arrival tracker will call late, at risk or on time.
// The due time is set from Mapbox's live-traffic drive time, the tech drives at
// real speed, and "Hit traffic" stalls the truck so the ETA visibly slips.

export const arrivalDemoRouter = Router();

const SCENARIOS: DemoScenario[] = ["late", "at_risk", "on_time"];
// Distance that usually means a 10–15 minute drive: long enough to watch, short enough to finish
const IDEAL_DEMO_METERS = 8_000;

function validCoords(c: unknown): c is Coordinates {
	const x = c as Coordinates | null;
	return !!x && typeof x.lat === "number" && typeof x.lon === "number" && !(x.lat === 0 && x.lon === 0);
}

function meters(a: Coordinates, b: Coordinates): number {
	const R = 6_371_000;
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(b.lat - a.lat);
	const dLon = toRad(b.lon - a.lon);
	const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Seconds of slack between the live-traffic ETA and the promised time. */
function slackSec(scenario: DemoScenario, driveSec: number): number {
	if (scenario === "late") return -Math.max(10 * 60, driveSec * 0.3);
	if (scenario === "at_risk") return 3 * 60; // inside the tracker's 10-min at-risk band
	return 25 * 60;
}

function hhmm(d: Date, tz: string): string {
	return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

// Every backend tech, so a demo can use the seeded crew, not just sim-created techs
arrivalDemoRouter.get("/demo/techs", async (_req, res, next) => {
	try {
		const techs = await api.listTechnicians();
		res.json(
			techs.map((t) => ({
				id: t.id,
				name: t.name,
				status: t.status,
				coords: validCoords(t.coords) ? t.coords : null,
			})),
		);
	} catch (err) {
		next(err);
	}
});

arrivalDemoRouter.post("/demo/arrival", async (req, res, next) => {
	try {
		const { techId, scenario, clientId } = req.body ?? {};
		if (!techId || typeof techId !== "string") return res.status(400).json({ error: "techId is required" });
		if (!SCENARIOS.includes(scenario)) {
			return res.status(400).json({ error: `scenario must be one of ${SCENARIOS.join(", ")}` });
		}

		const techs = await api.listTechnicians();
		const tech = techs.find((t) => t.id === techId);
		if (!tech) return res.status(404).json({ error: "Technician not found" });

		const op = simulation.ensureRegistered({
			techId: tech.id,
			name: tech.name,
			coords: validCoords(tech.coords) ? tech.coords : config.homeCoords,
		});
		if (op.state !== "Idle") {
			return res.status(409).json({ error: `${tech.name} is busy (${op.state}). Pause or replay them first.` });
		}
		const origin = op.coords;

		const clients = (await api.listClients()).filter((c) => validCoords(c.coords));
		const client = clientId
			? clients.find((c) => c.id === clientId)
			: clients
					.filter((c) => meters(origin, c.coords as Coordinates) > 1_500)
					.sort(
						(a, b) =>
							Math.abs(meters(origin, a.coords as Coordinates) - IDEAL_DEMO_METERS) -
							Math.abs(meters(origin, b.coords as Coordinates) - IDEAL_DEMO_METERS),
					)[0];
		if (!client) return res.status(400).json({ error: "No client with a map location to drive to" });
		const dest = client.coords as Coordinates;

		const route = await getDirections(origin, dest, "driving-traffic");
		if (!route) return res.status(502).json({ error: "Mapbox couldn't route that drive" });

		const tz = await api.getOrgTimezone();
		const now = Date.now();
		// Whole minutes, never in the past: the visit's promise is an HH:MM
		const dueMs = Math.max(
			Math.ceil((now + (route.duration + slackSec(scenario, route.duration)) * 1000) / 60_000) * 60_000,
			Math.ceil((now + 60_000) / 60_000) * 60_000,
		);
		const due = new Date(dueMs);

		const label = { late: "Late", at_risk: "At risk", on_time: "On time" }[scenario as DemoScenario];
		const job = await api.createJob({
			name: `Arrival demo — ${label}`,
			client_id: client.id,
			address: client.address,
			coords: dest,
			description: "Created by the user simulator's arrival demo",
		});
		const visit = await api.createAtVisit({
			job_id: job.id,
			name: `Arrival demo — ${label}`,
			scheduled_start_at: due.toISOString(),
			scheduled_end_at: new Date(dueMs + 60 * 60_000).toISOString(),
			arrival_time: hhmm(due, tz),
			tech_ids: [tech.id],
		});

		await api.pingTechnician(tech.id, origin);
		await api.transitionVisit(visit.id, "drive", origin);

		op.startDemoDrive({
			visit,
			geometry: route.geometry,
			demo: {
				scenario,
				visitId: visit.id,
				jobId: job.id,
				clientName: client.name,
				dueAt: due.toISOString(),
				driveSec: Math.round(route.duration),
				startedAt: new Date(now).toISOString(),
				stalledSec: 0,
				stalledUntil: null,
				arrivedAt: null,
			},
		});

		const warning =
			scenario === "late" && route.duration < 7 * 60
				? "This drive is under 7 minutes, so it may not register as late — pick a farther client."
				: undefined;
		console.log(
			`[demo] ${tech.name} → ${client.name}: ${Math.round(route.duration / 60)} min drive, due ${hhmm(due, tz)} (${scenario})`,
		);
		res.status(201).json({ snapshot: op.snapshot(), warning });
	} catch (err) {
		next(err);
	}
});

arrivalDemoRouter.post("/demo/arrival/:techId/stall", (req, res) => {
	const op = simulation.get(req.params.techId);
	if (!op) return res.status(404).json({ error: "Unknown tech" });
	const minutes = Number(req.body?.minutes ?? 5);
	if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60) {
		return res.status(400).json({ error: "minutes must be between 1 and 60" });
	}
	try {
		op.stall(minutes);
		res.json(op.snapshot());
	} catch (err) {
		res.status(409).json({ error: (err as Error).message });
	}
});

// Cancels the demo visit if the tech hasn't arrived; otherwise just clears the panel
arrivalDemoRouter.post("/demo/arrival/:techId/end", async (req, res, next) => {
	try {
		const op = simulation.get(req.params.techId);
		if (!op?.demo) return res.status(404).json({ error: "No demo for that tech" });
		if (!op.demo.arrivedAt) await api.cancelVisit(op.demo.visitId, "Arrival demo ended");
		op.endDemo();
		res.json(op.snapshot());
	} catch (err) {
		next(err);
	}
});
