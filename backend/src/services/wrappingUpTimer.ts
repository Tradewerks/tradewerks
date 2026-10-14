import { checkAndClearWrappingUp } from "../controllers/techniciansController.js";
import { emitToOrg } from "./socketService.js";
import { log } from "./appLogger.js";
import { db } from "../db.js";

const timers = new Map<string, NodeJS.Timeout>();

export function scheduleWrappingUpClear(
	techId: string,
	orgId: string,
	clockedOutAt: Date,
	wrappingMinutes: number,
) {
	cancelWrappingUpTimer(techId);
	const expiresAt = clockedOutAt.getTime() + wrappingMinutes * 60_000;
	const delayMs = Math.max(expiresAt - Date.now(), 0);
	timers.set(
		techId,
		setTimeout(() => clearWrappingUpNow(techId, orgId), delayMs),
	);
}

export function cancelWrappingUpTimer(techId: string) {
	const t = timers.get(techId);
	if (t) {
		clearTimeout(t);
		timers.delete(techId);
	}
}

async function clearWrappingUpNow(techId: string, orgId: string) {
	timers.delete(techId);
	try {
		const updated = await checkAndClearWrappingUp(techId, orgId);
		if (updated) {
			emitToOrg(orgId, "technician-update", updated);
			emitToOrg(orgId, "technician:status_changed", {
				techId: updated.id,
				techName: updated.name,
				newStatus: "Available",
				changeType: "wrapping_up_cleared",
				changedAt: new Date().toISOString(),
			});
		}
	} catch (e) {
		log.error({ err: e }, `wrappingUpTimer: clearWrappingUpNow failed for tech ${techId}`);
	}
}

export async function rearmWrappingUpTimers() {
	try {
		const wrappingTechs = await db.technician.findMany({
			where: { status: "WrappingUp" },
			select: {
				id: true,
				organization_id: true,
				organization: { select: { wrapping_up_minutes: true } },
			},
		});

		for (const tech of wrappingTechs) {
			if (!tech.organization_id) continue;

			const lastEntry = await db.visit_tech_time_entry.findFirst({
				where: { tech_id: tech.id, clocked_out_at: { not: null } },
				orderBy: { clocked_out_at: "desc" },
				select: { clocked_out_at: true },
			});

			const wrappingMinutes = tech.organization?.wrapping_up_minutes ?? 15;
			const clockedOutAt = lastEntry?.clocked_out_at ?? new Date();
			scheduleWrappingUpClear(tech.id, tech.organization_id, clockedOutAt, wrappingMinutes);
		}

		log.info(`Rearmed WrappingUp timers for ${wrappingTechs.length} technician(s)`);
	} catch (e) {
		log.error({ err: e }, "rearmWrappingUpTimers failed");
	}
}
