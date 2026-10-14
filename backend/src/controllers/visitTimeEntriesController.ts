import { log } from "../services/appLogger.js";
import { logActivity } from "../services/logger.js";
import type { pause_reason_type, technician_status } from "../../generated/prisma/client.js";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { emitToOrg } from "../services/socketService.js";
import { buildVisitStatusPayload, buildSecondaryEventPayload } from "./jobVisitsController.js";
import { isWeekLocked, TIMESHEET_LOCKED } from "./timesheetController.js";

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
			return { err: "VISIT_NOT_READY: Visit must be OnSite, InProgress, or Paused before clocking in" };
		}

		const assignment = await sdb.job_visit_technician.findUnique({
			where: { visit_id_tech_id: { visit_id: visitId, tech_id: techId } },
		});
		if (!assignment) return { err: "Technician not assigned to this visit" };

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
		const isPrimaryAdvance = CLOCK_IN_AUTO_ADVANCE.includes(visit.status);

		const entry = await sdb.$transaction(async (tx) => {
			const newEntry = await tx.visit_tech_time_entry.create({
				data: { visit_id: visitId, tech_id: techId, clocked_in_at: now },
				include: { tech: { select: { id: true, name: true } } },
			});

			// Auto-advance: OnSite → InProgress (begin), Paused → InProgress (resume)
			if (isPrimaryAdvance) {
				await tx.job_visit.update({
					where: { id: visitId },
					data: {
						status: "InProgress",
						...(visit.status === "OnSite" && { actual_start_at: visit.actual_start_at ?? now }),
					},
				});
				if (visit.job.status !== "InProgress") {
					await tx.job.update({
						where: { id: visit.job.id },
						data: { status: "InProgress", status_changed_at: new Date() },
					});
				}
			}

			// Update global tech status
			await tx.technician.update({
				where: { id: techId },
				data: { status: "Working" },
			});
			// Cancel any pending WrappingUp timer — tech is now actively working
			import("../services/wrappingUpTimer.js").then(({ cancelWrappingUpTimer }) => {
				cancelWrappingUpTimer(techId);
			}).catch(() => {});

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

		const updatedVisit = await sdb.job_visit.findFirst({
			where: { id: visitId },
			include: {
				job: { include: { client: true } },
				visit_techs: { include: { tech: true } },
			},
		});

		if (updatedVisit) {
			if (isPrimaryAdvance) {
				emitToOrg(organizationId,
					"job_visit:status_changed",
					buildVisitStatusPayload(updatedVisit, visit.status, true, context),
				);
				await logActivity({
					event_type: "job_visit.updated",
					action: "updated",
					entity_type: "job_visit",
					entity_id: visitId,
					organization_id: organizationId,
					actor_type: "technician",
					actor_id: techId,
					changes: { status: { old: visit.status, new: "InProgress" } },
				});
			} else {
				// Secondary: tech clocked into an already-InProgress visit
				emitToOrg(organizationId,
					"job_visit:status_changed",
					buildSecondaryEventPayload(updatedVisit, "InProgress", context),
				);
			}
		}

		return { err: "", item: entry };
	} catch (e) {
		log.error({ err: e }, "clockInVisit failed");
		return { err: "Internal server error" };
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
		if (!openEntry) return { err: "No active clock-in found for this technician on this visit" };

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

		const result = await sdb.$transaction(async (tx) => {
			const closedEntry = await tx.visit_tech_time_entry.update({
				where: { id: openEntry.id },
				data: { clocked_out_at: now, hours_worked: hoursWorked },
			});

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

			await tx.visit_tech_time_entry.update({
				where: { id: closedEntry.id },
				data: { line_item_id: lineItem.id },
			});

			// Recalculate visit financials
			const visitWithItems = await tx.job_visit.findUnique({
				where: { id: visitId },
				include: { line_items: true },
			});
			if (visitWithItems) {
				const newSubtotal = visitWithItems.line_items.reduce((s, li) => s + Number(li.total), 0);
				const taxRate = Number(visitWithItems.tax_rate);
				const newTaxAmount = parseFloat((newSubtotal * taxRate).toFixed(2));
				await tx.job_visit.update({
					where: { id: visitId },
					data: {
						subtotal: newSubtotal,
						tax_amount: newTaxAmount,
						total: parseFloat((newSubtotal + newTaxAmount).toFixed(2)),
					},
				});
			}

			// is_last_tech: any other open entries on this visit?
			const remainingOpen = await tx.visit_tech_time_entry.findFirst({
				where: {
					visit_id: visitId,
					clocked_out_at: null,
					id: { not: openEntry.id },
				},
			});

			// Auto-pause when last tech clocks out of an InProgress visit
			let statusChangedToPaused = false;
			if (remainingOpen === null) {
				const currentVisit = await tx.job_visit.findUnique({
					where: { id: visitId },
					select: { status: true },
				});
				if (currentVisit?.status === "InProgress") {
					await tx.job_visit.update({ where: { id: visitId }, data: { status: "Paused" } });
					statusChangedToPaused = true;
				}
			}

			// Save pause reason only when this clock-out actually caused the visit to pause
			if (statusChangedToPaused) {
				await tx.visit_tech_time_entry.update({
					where: { id: closedEntry.id },
					data: { pause_reason: toPauseReason(pauseReason) },
				});
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

			return { entry: closedEntry, line_item: lineItem, is_last_tech: remainingOpen === null, statusChangedToPaused };
		});

		const updatedVisit = await sdb.job_visit.findFirst({
			where: { id: visitId },
			include: {
				job: { include: { client: true } },
				visit_techs: { include: { tech: true } },
			},
		});

		if (updatedVisit) {
			if (result.statusChangedToPaused) {
				emitToOrg(organizationId,
					"job_visit:status_changed",
					buildVisitStatusPayload(updatedVisit, "InProgress", true, context),
				);
				await logActivity({
					event_type: "job_visit.updated",
					action: "updated",
					entity_type: "job_visit",
					entity_id: visitId,
					organization_id: organizationId,
					actor_type: "technician",
					actor_id: techId,
					changes: { status: { old: "InProgress", new: "Paused" } },
				});
			} else if (!result.is_last_tech) {
				// Secondary: tech clocked out but visit stays InProgress
				emitToOrg(organizationId,
					"job_visit:status_changed",
					buildSecondaryEventPayload(updatedVisit, "Paused", context),
				);
			}
		}

		return { err: "", item: result };
	} catch (e) {
		log.error({ err: e }, "clockOutVisit failed");
		return { err: "Internal server error" };
	}
};
