import { config } from "../config.js";
import * as api from "../services/backendApi.js";
import { getDirections } from "../services/mapboxService.js";
import { buildInterpolator, type RouteInterpolator } from "../lib/routeInterpolator.js";
import type { Coordinates } from "../types/location.js";
import type { JobVisit } from "../types/jobs.js";

export type TechState = "Idle" | "Driving" | "OnSite" | "Working";

export type DemoScenario = "late" | "at_risk" | "on_time";

/** A real-time drive staged so the backend arrival tracker has something to forecast. */
export type ArrivalDemo = {
	scenario: DemoScenario;
	visitId: string;
	jobId: string;
	clientName: string;
	dueAt: string;
	driveSec: number; // live-traffic drive time when the demo started
	startedAt: string;
	stalledSec: number; // traffic injected with "Hit traffic"
	stalledUntil: string | null;
	arrivedAt: string | null;
	progress: number; // 0..1 along the route
};

export type TechSnapshot = {
	techId: string;
	name: string;
	state: TechState;
	currentVisitId: string | null;
	coords: Coordinates;
	isActive: boolean;
	demo: ArrivalDemo | null;
};

function visitStart(v: JobVisit): Date {
	return new Date(v.scheduled_start_at);
}

export class TechnicianOperator {
	public readonly techId: string;
	public readonly name: string;
	public isActive = false;

	public coords: Coordinates;
	public state: TechState = "Idle";

	public currentVisit: JobVisit | null = null;
	private interpolator: RouteInterpolator | null = null;
	private phaseStartedAt = 0; // ms epoch when current phase began
	private idlePollCounter = 0;
	private tickBusy = false;

	public demo: ArrivalDemo | null = null;
	private stallUntil = 0;
	private lastTickAt = 0;

	constructor(args: { techId: string; name: string; coords: Coordinates }) {
		this.techId = args.techId;
		this.name = args.name;
		this.coords = args.coords;
	}

	snapshot(): TechSnapshot {
		return {
			techId: this.techId,
			name: this.name,
			state: this.state,
			currentVisitId: this.currentVisit?.id ?? null,
			coords: this.coords,
			isActive: this.isActive,
			demo: this.demo
				? {
						...this.demo,
						stalledUntil: this.stallUntil > Date.now() ? new Date(this.stallUntil).toISOString() : null,
						progress: this.demoProgress(),
					}
				: null,
		};
	}

	/** Reset all in-memory sim state for this tech. Caller handles backend reset. */
	resetToIdle(coords: Coordinates) {
		this.state = "Idle";
		this.currentVisit = null;
		this.interpolator = null;
		this.phaseStartedAt = 0;
		this.idlePollCounter = 0;
		this.coords = coords;
		this.demo = null;
		this.stallUntil = 0;
	}

	get demoDriving(): boolean {
		return !!this.demo && !this.demo.arrivedAt && this.state === "Driving";
	}

	/**
	 * Drive to a demo visit at real speed: the route's live-traffic duration, not
	 * TRAVEL_DURATION_SEC. The tracker forecasts against the wall clock, so a
	 * compressed drive would arrive before it ever looked.
	 */
	startDemoDrive(args: { visit: JobVisit; geometry: Parameters<typeof buildInterpolator>[0]; demo: Omit<ArrivalDemo, "progress"> }) {
		this.currentVisit = args.visit;
		this.interpolator = buildInterpolator(args.geometry, args.demo.driveSec);
		this.demo = { ...args.demo, progress: 0 };
		this.stallUntil = 0;
		this.state = "Driving";
		this.phaseStartedAt = Date.now();
		this.lastTickAt = Date.now();
	}

	/** Stop the truck for a while — what a jam looks like from GPS. */
	stall(minutes: number) {
		if (!this.demoDriving || !this.demo) throw new Error("No demo drive in progress");
		this.stallUntil = Math.max(Date.now(), this.stallUntil) + minutes * 60_000;
		this.demo.stalledSec += minutes * 60;
	}

	endDemo() {
		this.demo = null;
		this.stallUntil = 0;
		if (this.state === "Driving") {
			this.state = "Idle";
			this.currentVisit = null;
			this.interpolator = null;
		}
	}

	private demoProgress(): number {
		if (!this.demo) return 0;
		if (this.demo.arrivedAt) return 1;
		if (!this.interpolator || this.state !== "Driving") return 0;
		return Math.min(1, (Date.now() - this.phaseStartedAt) / 1000 / this.interpolator.totalSec);
	}

	async tick(): Promise<void> {
		if ((!this.isActive && !this.demoDriving) || this.tickBusy) return;
		this.tickBusy = true;
		try {
			switch (this.state) {
				case "Idle":
					await this.tickIdle();
					break;
				case "Driving":
					await this.tickDriving();
					break;
				case "OnSite":
					await this.tickOnSite();
					break;
				case "Working":
					await this.tickWorking();
					break;
			}
		} catch (e) {
			console.error(
				`[tech ${this.name}] tick error in state ${this.state}:`,
				(e as Error).message,
			);
		} finally {
			this.tickBusy = false;
		}
	}

	private async tickIdle(): Promise<void> {
		// Throttle polling for new work.
		if (this.idlePollCounter > 0) {
			this.idlePollCounter--;
			return;
		}
		this.idlePollCounter = config.idlePollTicks;

		const visits = await api.getTechnicianVisits(this.techId);
		const scheduled = visits
			.filter((v) => v.status === "Scheduled")
			.sort(
				(a, b) => visitStart(a).getTime() - visitStart(b).getTime(),
			);
		const next = scheduled[0];
		if (!next) return;

		const destCoords = this.visitCoords(next);
		if (!destCoords) {
			console.warn(
				`[tech ${this.name}] visit ${next.id} has no coords; skipping`,
			);
			return;
		}

		const route = await getDirections(this.coords, destCoords);
		if (!route) {
			console.warn(
				`[tech ${this.name}] mapbox route failed; cannot start visit ${next.id}`,
			);
			return;
		}

		this.interpolator = buildInterpolator(
			route.geometry,
			config.travelDurationSec,
		);

		await api.updateJobVisit(next.id, {
			status: "Driving",
			actual_start_at: new Date().toISOString(),
		});

		this.currentVisit = next;
		this.state = "Driving";
		this.phaseStartedAt = Date.now();
		console.log(
			`[tech ${this.name}] Idle → Driving (visit ${next.id})`,
		);
	}

	private async tickDriving(): Promise<void> {
		if (!this.currentVisit || !this.interpolator) {
			this.state = "Idle";
			return;
		}

		const now = Date.now();
		// Stalled: the clock runs, the truck doesn't
		if (this.stallUntil > now && this.lastTickAt) this.phaseStartedAt += now - this.lastTickAt;
		this.lastTickAt = now;

		const elapsedSec = (now - this.phaseStartedAt) / 1000;
		const pos = this.interpolator.at(elapsedSec);
		this.coords = pos;
		await api.pingTechnician(this.techId, pos);

		if (this.demo && elapsedSec >= this.interpolator.totalSec) {
			await api.transitionVisit(this.currentVisit.id, "arrive", pos);
			this.demo.arrivedAt = new Date().toISOString();
			console.log(`[tech ${this.name}] demo arrived (visit ${this.currentVisit.id})`);
			// Leave the visit On Site so the arrival shows on the board; dispatch closes it
			this.currentVisit = null;
			this.interpolator = null;
			this.state = "Idle";
			this.idlePollCounter = config.idlePollTicks;
			return;
		}

		if (elapsedSec >= this.interpolator.totalSec) {
			await api.updateJobVisit(this.currentVisit.id, { status: "OnSite" });
			this.state = "OnSite";
			this.phaseStartedAt = Date.now();
			this.interpolator = null;
			console.log(
				`[tech ${this.name}] Driving → OnSite (visit ${this.currentVisit.id})`,
			);
		}
	}

	private async tickOnSite(): Promise<void> {
		if (!this.currentVisit) {
			this.state = "Idle";
			return;
		}
		const elapsedSec = (Date.now() - this.phaseStartedAt) / 1000;
		if (elapsedSec >= config.dwellOnsiteSec) {
			await api.updateJobVisit(this.currentVisit.id, {
				status: "InProgress",
			});
			this.state = "Working";
			this.phaseStartedAt = Date.now();
			console.log(
				`[tech ${this.name}] OnSite → Working (visit ${this.currentVisit.id})`,
			);
		}
	}

	private async tickWorking(): Promise<void> {
		if (!this.currentVisit) {
			this.state = "Idle";
			return;
		}
		const elapsedSec = (Date.now() - this.phaseStartedAt) / 1000;
		if (elapsedSec >= config.workDurationSec) {
			await api.updateJobVisit(this.currentVisit.id, {
				status: "Completed",
				actual_end_at: new Date().toISOString(),
			});
			console.log(
				`[tech ${this.name}] Working → Completed (visit ${this.currentVisit.id})`,
			);
			this.currentVisit = null;
			this.state = "Idle";
			this.idlePollCounter = 0; // check for next visit immediately
		}
	}

	private visitCoords(v: JobVisit): Coordinates | null {
		const c = v.job?.coords;
		if (!c) return null;
		if (typeof c.lat !== "number" || typeof c.lon !== "number") return null;
		return { lat: c.lat, lon: c.lon };
	}
}
