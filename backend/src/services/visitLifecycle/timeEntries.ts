import type {
	Prisma,
	pause_reason_type,
} from "../../../generated/prisma/client.js";
import { recomputeVisitTotals } from "../../lib/recomputeDocumentTotals.js";

const PAUSE_REASONS = new Set<string>([
	"AwaitingMaterials",
	"EquipmentIssue",
	"Break",
	"Other",
]);

function toPauseReason(v: string | undefined): pause_reason_type | undefined {
	if (!v || !PAUSE_REASONS.has(v)) return undefined;
	return v as pause_reason_type;
}

/** Clocks out everyone still on the visit, billing each entry as a labor line. */
export async function closeOpenTimeEntries(
	tx: Prisma.TransactionClient,
	orgId: string,
	visitId: string,
	at: Date,
	pauseReason?: string,
): Promise<{ techIds: string[] }> {
	const openEntries = await tx.visit_tech_time_entry.findMany({
		where: {
			visit_id: visitId,
			clocked_out_at: null,
			visit: { job: { organization_id: orgId } },
		},
		include: {
			tech: { select: { id: true, name: true, hourly_rate: true } },
		},
	});
	const reason = toPauseReason(pauseReason);

	const closedTechIds: string[] = [];
	for (const entry of openEntries) {
		const elapsedMs = at.getTime() - entry.clocked_in_at.getTime();
		const hoursWorked = parseFloat(
			(elapsedMs / (1000 * 60 * 60)).toFixed(4),
		);
		const hourlyRate = Number(entry.tech.hourly_rate);
		const laborTotal = parseFloat((hoursWorked * hourlyRate).toFixed(2));

		// Claim the entry first: a concurrent clock-out that already closed it
		// billed those hours, and must not be overwritten or billed again.
		const claimed = await tx.visit_tech_time_entry.updateMany({
			where: { id: entry.id, clocked_out_at: null },
			data: {
				clocked_out_at: at,
				hours_worked: hoursWorked,
				...(reason ? { pause_reason: reason } : {}),
			},
		});
		if (claimed.count === 0) continue;

		const lineItem = await tx.job_visit_line_item.create({
			data: {
				visit_id: visitId,
				name: `Labor – ${entry.tech.name}`,
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
			where: { id: entry.id },
			data: { line_item_id: lineItem.id },
		});
		closedTechIds.push(entry.tech_id);
	}

	if (closedTechIds.length > 0) {
		await recomputeVisitTotals(visitId, orgId, tx);
	}
	return { techIds: [...new Set(closedTechIds)] };
}
