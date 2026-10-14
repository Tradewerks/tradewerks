import { config } from "../config.js";
import * as api from "../services/backendApi.js";
import { TechnicianOperator, type TechSnapshot } from "../operators/technician.js";
import type { Coordinates } from "../types/location.js";

export class SimulationManager {
	private techs = new Map<string, TechnicianOperator>();
	private timer: NodeJS.Timeout | null = null;

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			for (const t of this.techs.values()) {
				// fire-and-forget; tick is self-guarded against overlap
				void t.tick();
			}
		}, config.tickIntervalMs);
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	register(args: {
		techId: string;
		name: string;
		coords: Coordinates;
	}): TechSnapshot {
		const op = new TechnicianOperator(args);
		this.techs.set(args.techId, op);
		return op.snapshot();
	}

	/** Existing backend techs (not created here) can be driven too, e.g. for demos. */
	ensureRegistered(args: { techId: string; name: string; coords: Coordinates }): TechnicianOperator {
		const existing = this.techs.get(args.techId);
		if (existing) return existing;
		const op = new TechnicianOperator(args);
		this.techs.set(args.techId, op);
		return op;
	}

	get(id: string): TechnicianOperator | undefined {
		return this.techs.get(id);
	}

	list(): TechSnapshot[] {
		return Array.from(this.techs.values()).map((t) => t.snapshot());
	}

	setActive(id: string, active: boolean): TechSnapshot {
		const op = this.require(id);
		op.isActive = active;
		return op.snapshot();
	}

	async replay(id: string): Promise<TechSnapshot> {
		const op = this.require(id);

		const visits = await api.getTechnicianVisits(id);
		for (const v of visits) {
			if (v.status !== "Scheduled") {
				await api.updateJobVisit(v.id, {
					status: "Scheduled",
					actual_start_at: null,
					actual_end_at: null,
				});
			}
		}

		await api.pingTechnician(id, config.homeCoords);
		op.resetToIdle(config.homeCoords);
		return op.snapshot();
	}

	private require(id: string): TechnicianOperator {
		const op = this.techs.get(id);
		if (!op) throw new Error(`Unknown tech: ${id}`);
		return op;
	}
}

export const simulation = new SimulationManager();
