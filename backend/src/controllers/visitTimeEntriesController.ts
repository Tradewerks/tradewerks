import { log } from "../services/appLogger.js";
import { logActivity } from "../services/logger.js";
import type { pause_reason_type, technician_status } from "../../generated/prisma/client.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { emitToOrg } from "../services/socketService.js";
import { buildSecondaryEventPayload } from "./jobVisitsController.js";
import { recomputeVisitTotals } from "../lib/recomputeDocumentTotals.js";
import { isWeekLocked, TIMESHEET_LOCKED } from "./timesheetController.js";
import {
	LifecycleRefusal,
	applyStatusChange,
	runPostCommit,
	type PostCommitEffects,
} from "../services/visitLifecycle/index.js";

const NOT_ASSIGNED = "Technician not assigned to this visit";
class NotAssignedError extends Error {}
const NO_OPEN_ENTRY = "No active clock-in found for this technician on this visit";
class AlreadyClockedOutError extends Error {}
const VISIT_NOT_READY = "VISIT_NOT_READY: Visit must be OnSite, InProgress, or Paused before clocking in";

const CLOCK_IN_ALLOWED = ["OnSite", "InProgress", "Paused"];
const CLOCK_IN_AUTO_ADVANCE = ["OnSite", "Paused"];

const VALID_PAUSE_REASONS = new Set<string>(["AwaitingMaterials", "EquipmentIssue", "Break", "Other"]);
function toPauseReason(v: string | undefined): pause_reason_type | undefined {
	if (!v || !VALID_PAUSE_REASONS.has(v)) return undefined;
	return v as pause_reason_type;
}

export const clockInVisit = async (
	visitId: string,
	techId: string,
	organizationId: string,
	context?: UserContext,
): Promise<{ err: string; item?: any }> => {
	try {
		const sdb = getScopedDb(organizationId);
		const visit = await sdb.job_visit.findFirst({
			where: { id: visitId, job: { organization_id: organizationId } },
			include: { job: { select: { id: true, job_number: true, status: true } } },
		});
		if (!visit) return { err: "Job visit not found" };

		if (!CLOCK_IN_ALLOWED.includes(visit.status)) {
			return { err: VISIT_NOT_READY };
		}

		const assignment = await sdb.job_visit_technician.findUnique({
			where: { visit_id_tech_id: { visit_id: visitId, tech_id: techId } },
		});
		if (!assignment) return { err: NOT_ASSIGNED };

		// Enforce global 1-open-entry constraint
		const existingOpen = await sdb.visit_tech_time_entry.findFirst({
			where: { tech_id: techId, clocked_out_at: null },
			include: { visit: { select: { id: true } } },
		});
		if (existingOpen) {
			return { err: `ALREADY_CLOCKED_IN:${existingOpen.visit.id}` };
		}
		if (await isWeekLocked(organizationId, techId)) return { err: TIMESHEET_LOCKED };

		const now = new Date();

		let effects: PostCommitEffects | null = null;
		const entry = await sdb.$transaction(async (tx) => {
			// Same lock order as patchVisitTechnicians (visit, then assignment), so a
			// concurrent unassign either commits first and this finds no row, or
			// waits and then sees this open entry.
			const txc = tx as unknown as Prisma.TransactionClient;
			await txc.$queryRaw`SELECT id FROM job_visit WHERE id = ${visitId} FOR NO KEY UPDATE`;
			const stillAssigned = await txc.$queryRaw<unknown[]>`SELECT 1 FROM job_visit_technician WHERE visit_id = ${visitId} AND tech_id = ${techId} FOR SHARE`;
			if (stillAssigned.length === 0) throw new NotAssignedError();
			// The status read above predates the lock.
			const locked = await tx.job_visit.findFirst({
				where: { id: visitId },
				select: { status: true },
			});
			if (!locked || !CLOCK_IN_ALLOWED.includes(locked.status)) {
				throw new LifecycleRefusal("WRONG_STATE", VISIT_NOT_READY);
			}

			const newEntry = await tx.visit_tech_time_entry.create({
				data: { visit_id: visitId, tech_id: techId, clocked_in_at: now },
				include: { tech: { select: { id: true, name: true } } },
			});

			// Auto-advance: OnSite → InProgress (begin), Paused → InProgress (resume)
			if (CLOCK_IN_AUTO_ADVANCE.includes(locked.status)) {
				effects = await applyStatusChange(txc, {
					orgId: organizationId,
					visitId,
					action: locked.status === "OnSite" ? "start" : "resume",
					context,
					now,
					actingTechIds: [techId],
				});
			} else {
				await tx.technician.update({
					where: { id: techId },
					data: { status: "Working" },
				});
			}

			await logActivity({
				event_type: "visit_time_entry.clocked_in",
				action: "created",
				entity_type: "visit_tech_time_entry",
				entity_id: newEntry.id,
				organization_id: organizationId,
				actor_type: "technician",
				actor_id: techId,
				changes: {
					visit_id: { old: null, new: visitId },
					clocked_in_at: { old: null, new: now },
				},
			});

			return newEntry;
		});

		const advanced = effects as PostCommitEffects | null;
		if (advanced) {
			await runPostCommit(advanced, context);
		} else {
			import("../services/wrappingUpTimer.js").then(({ cancelWrappingUpTimer }) => {
				cancelWrappingUpTimer(techId);
			}).catch(() => {});
			const updatedVisit = await sdb.job_visit.findFirst({
				where: { id: visitId },
				include: {
					job: { include: { client: true } },
					visit_techs: { include: { tech: true } },
				},
			});
			// Secondary: tech clocked into an already-InProgress visit
			if (updatedVisit) {
				emitToOrg(organizationId,
					"job_visit:status_changed",
					buildSecondaryEventPayload(updatedVisit, "InProgress", context),
				);
			}
		}

		return { err: "", item: entry };
	} catch (e) {
		if (e instanceof NotAssignedError) return { err: NOT_ASSIGNED };
		if (e instanceof LifecycleRefusal) return { err: e.message };
		log.error({ err: e }, "clockInVisit failed");
		throw e;
	}
};

export const clockOutVisit = async (
	visitId: string,
	techId: string,
	organizationId: string,
	context?: UserContext,
	pauseReason?: string,
): Promise<{ err: string; item?: any }> => {
	try {
		const sdb = getScopedDb(organizationId);
		const openEntry = await sdb.visit_tech_time_entry.findFirst({
			where: { visit_id: visitId, tech_id: techId, clocked_out_at: null },
		});
		if (!openEntry) return { err: NO_OPEN_ENTRY };

		const tech = await sdb.technician.findFirst({
			where: { id: techId },
			select: { hourly_rate: true, name: true },
		});
		if (!tech) return { err: "Technician not found" };

		const now = new Date();
		const elapsedMs = now.getTime() - openEntry.clocked_in_at.getTime();
		const hoursWorked = parseFloat((elapsedMs / (1000 * 60 * 60)).toFixed(4));
		const hourlyRate = Number(tech.hourly_rate);
		const laborTotal = parseFloat((hoursWorked * hourlyRate).toFixed(2));

		let paused: PostCommitEffects | null = null;
		const result = await sdb.$transaction(async (tx) => {
			const txc = tx as unknown as Prisma.TransactionClient;
			// Visit before entry, the order every lifecycle writer takes, so a
			// concurrent complete can't deadlock with this or bill the entry twice.
			await txc.$queryRaw`SELECT id FROM job_visit WHERE id = ${visitId} FOR NO KEY UPDATE`;
			const claimed = await tx.visit_tech_time_entry.updateMany({
				where: { id: openEntry.id, clocked_out_at: null },
				data: { clocked_out_at: now, hours_worked: hoursWorked },
			});
			if (claimed.count === 0) throw new AlreadyClockedOutError();

			const lineItem = await tx.job_visit_line_item.create({
				data: {
					visit_id: visitId,
					name: `Labor – ${tech.name}`,
					description: `${hoursWorked.toFixed(2)} hrs @ $${hourlyRate.toFixed(2)}/hr`,
					quantity: hoursWorked,
					unit_price: hourlyRate,
					total: laborTotal,
					source: "field_addition",
					item_type: "labor",
					sort_order: 0,
				},
			});

			let closedEntry = await tx.visit_tech_time_entry.update({
				where: { id: openEntry.id },
				data: { line_item_id: lineItem.id },
			});

			// Per-line tax groups, discounts and kept rates live in the recompute, not here.
			await recomputeVisitTotals(visitId, organizationId, txc);

			// is_last_tech: any other open entries on this visit?
			const remainingOpen = await tx.visit_tech_time_entry.findFirst({
				where: {
					visit_id: visitId,
					clocked_out_at: null,
					id: { not: openEntry.id },
				},
			});

			// Auto-pause when last tech clocks out of an InProgress visit
			if (remainingOpen === null) {
				const currentVisit = await tx.job_visit.findUnique({
					where: { id: visitId },
					select: { status: true },
				});
				if (currentVisit?.status === "InProgress") {
					paused = await applyStatusChange(txc, {
						orgId: organizationId,
						visitId,
						action: "pause",
						context,
						now,
						pauseReason,
					});
					// Only when this clock-out actually paused the visit.
					closedEntry = await tx.visit_tech_time_entry.update({
						where: { id: openEntry.id },
						data: { pause_reason: toPauseReason(pauseReason) },
					});
				}
			}

			// Update global tech status.
			// Paused only when this tech's clock-out left no one working (visit pauses).
			// If others are still clocked in, this tech is still on-site but no longer working.
			const newGlobalStatus: technician_status = remainingOpen === null ? "Paused" : "OnSite";
			await tx.technician.update({
				where: { id: techId },
				data: { status: newGlobalStatus },
			});

			await logActivity({
				event_type: "visit_time_entry.clocked_out",
				action: "updated",
				entity_type: "visit_tech_time_entry",
				entity_id: closedEntry.id,
				organization_id: organizationId,
				actor_type: "technician",
				actor_id: techId,
				changes: {
					clocked_out_at: { old: null, new: now },
					hours_worked: { old: null, new: hoursWorked },
				},
			});

			return {
				entry: closedEntry,
				line_item: lineItem,
				is_last_tech: remainingOpen === null,
				statusChangedToPaused: paused !== null,
			};
		});

		const pause = paused as PostCommitEffects | null;
		if (pause) {
			await runPostCommit(pause, context);
		} else if (!result.is_last_tech) {
			const updatedVisit = await sdb.job_visit.findFirst({
				where: { id: visitId },
				include: {
					job: { include: { client: true } },
					visit_techs: { include: { tech: true } },
				},
			});
			// Secondary: tech clocked out but visit stays InProgress
			if (updatedVisit) {
				emitToOrg(organizationId,
					"job_visit:status_changed",
					buildSecondaryEventPayload(updatedVisit, "Paused", context),
				);
			}
		}

		return { err: "", item: result };
	} catch (e) {
		if (e instanceof AlreadyClockedOutError) return { err: NO_OPEN_ENTRY };
		if (e instanceof LifecycleRefusal) return { err: e.message };
		log.error({ err: e }, "clockOutVisit failed");
		throw e;
	}
};
