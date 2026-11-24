import { createNotification } from "../controllers/notificationsController.js";
import { emitToOrg } from "./socketService.js";

/** The in-app "visit assigned" notice every assignment path sends after commit. */
export async function notifyVisitAssigned(
	techIds: string[],
	visitId: string,
	clientName: string,
	startAt: Date,
	organizationId: string,
	timeZone: string,
): Promise<void> {
	const scheduledAt = startAt.toLocaleString("en-US", {
		timeZone,
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
	for (const techId of techIds) {
		await createNotification(
			{
				technicianId: techId,
				type: "visit_assigned",
				title: `New visit assigned: ${clientName}`,
				body: `You have been assigned to a visit at ${clientName} on ${scheduledAt}.`,
				vars: { client: clientName, at: startAt.toISOString() },
				actionUrl: `/technician/visits/${visitId}`,
			},
			organizationId,
		);
	}
	emitToOrg(organizationId, "job_visit:updated", { visitId, organizationId });
}
