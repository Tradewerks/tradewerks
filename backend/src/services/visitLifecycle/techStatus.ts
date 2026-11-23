import type {
	Prisma,
	tech_visit_status,
	technician_status,
} from "../../../generated/prisma/client.js";
import type { VisitAction } from "./transitions.js";

export interface TechStatusResult {
	wrappingUpTechIds: string[];
	activatedTechIds: string[];
}

const ACTING: Partial<
	Record<VisitAction, { row?: tech_visit_status; global: technician_status }>
> = {
	drive: { row: "EnRoute", global: "EnRoute" },
	arrive: { row: "OnSite", global: "OnSite" },
	start: { global: "Working" },
	resume: { global: "Working" },
};

/**
 * Per-tech side of a visit transition. Runs after the visit row write, so the
 * visit lock is already held when assignment rows are touched.
 */
export async function applyTechStatus(
	tx: Prisma.TransactionClient,
	args: {
		visitId: string;
		action: VisitAction;
		actingTechIds: string[];
		// Techs whose time entries this transition just closed: they worked the
		// visit even if their assignment row never left Assigned.
		closedTechIds: string[];
	},
): Promise<TechStatusResult> {
	const { visitId, action, actingTechIds, closedTechIds } = args;
	const none: TechStatusResult = {
		wrappingUpTechIds: [],
		activatedTechIds: [],
	};

	if (action === "complete" || action === "record_complete") {
		const rows = await tx.job_visit_technician.findMany({
			where: { visit_id: visitId },
			select: { tech_id: true, tech_status: true },
		});
		// No-shows still at Assigned are not marked Done. Rows already Done (a
		// reopened visit) are left alone unless they clocked in again, so a
		// re-completion doesn't drag an idle tech back into WrappingUp.
		const progressed = rows
			.filter((r) =>
				closedTechIds.includes(r.tech_id)
					? true
					: r.tech_status !== "Assigned" && r.tech_status !== "Done",
			)
			.map((r) => r.tech_id);
		if (progressed.length === 0) return none;

		await tx.job_visit_technician.updateMany({
			where: { visit_id: visitId, tech_id: { in: progressed } },
			data: { tech_status: "Done" },
		});
		const techs = await tx.technician.findMany({
			where: { id: { in: progressed } },
			select: { id: true, status: true },
		});
		const wrappingUpTechIds: string[] = [];
		for (const t of techs) {
			if (t.status === "Break") {
				// Returning from the break restores pre_break_status, which would
				// otherwise still say OnSite/Working for a finished visit.
				await tx.technician_shift_break.updateMany({
					where: { tech_id: t.id, ended_at: null },
					data: { pre_break_status: "WrappingUp" },
				});
			} else {
				await tx.technician.update({
					where: { id: t.id },
					data: { status: "WrappingUp" },
				});
				wrappingUpTechIds.push(t.id);
			}
		}
		return { wrappingUpTechIds, activatedTechIds: [] };
	}

	if (action === "pause") {
		// tech_status on the visit stays OnSite; only the global status moves.
		const rows = await tx.job_visit_technician.findMany({
			where: {
				visit_id: visitId,
				tech_status: { notIn: ["Done", "Assigned"] },
			},
			select: { tech_id: true },
		});
		if (rows.length > 0) {
			await tx.technician.updateMany({
				where: { id: { in: rows.map((r) => r.tech_id) } },
				data: { status: "Paused" },
			});
		}
		return none;
	}

	if (action === "cancel") {
		const activeRows = await tx.job_visit_technician.findMany({
			where: {
				visit_id: visitId,
				tech_status: { notIn: ["Assigned", "Done"] },
			},
			select: { tech_id: true },
		});
		await tx.job_visit_technician.updateMany({
			where: { visit_id: visitId, tech_status: { not: "Done" } },
			data: { tech_status: "Assigned" },
		});
		const activeTechIds = [
			...new Set([...activeRows.map((r) => r.tech_id), ...closedTechIds]),
		];
		for (const techId of activeTechIds) {
			const tech = await tx.technician.findUnique({
				where: { id: techId },
				select: { status: true },
			});
			// The break restores their status when it ends.
			if (tech?.status === "Break") continue;
			const openShift = await tx.technician_shift.findFirst({
				where: { tech_id: techId, ended_at: null },
				select: { id: true },
			});
			await tx.technician.update({
				where: { id: techId },
				data: { status: openShift ? "Available" : "Offline" },
			});
		}
		return none;
	}

	if (action === "recall") {
		await tx.job_visit_technician.updateMany({
			where: {
				visit_id: visitId,
				tech_id: { in: actingTechIds },
				tech_status: "EnRoute",
			},
			data: { tech_status: "Assigned" },
		});
		return none;
	}

	const acting = ACTING[action];
	if (!acting || actingTechIds.length === 0) return none;
	if (acting.row) {
		await tx.job_visit_technician.updateMany({
			where: { visit_id: visitId, tech_id: { in: actingTechIds } },
			data: { tech_status: acting.row },
		});
	}
	await tx.technician.updateMany({
		where: { id: { in: actingTechIds } },
		data: { status: acting.global },
	});
	return { wrappingUpTechIds: [], activatedTechIds: [...actingTechIds] };
}
