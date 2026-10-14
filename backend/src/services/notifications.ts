import * as notificationsController from "../controllers/notificationsController.js";
import { db } from "../db.js";
import { log } from "./appLogger.js";

export function startVisitReminderInterval(): void {
	// Every 60 s, find visits starting in ~30 min and notify assigned techs once.
	setInterval(async () => {
		try {
			const now = new Date();
			const windowStart = new Date(now.getTime() + 25 * 60_000);
			const windowEnd   = new Date(now.getTime() + 35 * 60_000);

			const upcoming = await db.job_visit.findMany({
				where: {
					scheduled_start_at: { gte: windowStart, lte: windowEnd },
					status: { notIn: ["Cancelled", "Completed"] },
				},
				include: {
					visit_techs: { select: { tech_id: true } },
					job: { select: { organization_id: true, client: { select: { name: true } } } },
				},
			});

			if (upcoming.length === 0) return;

			// Batch idempotency check — one query for all upcoming visits
			const actionUrls = upcoming.map(v => `/technician/visits/${v.id}`);
			const existingReminders = await db.technician_notification.findMany({
				where: { type: "visit_reminder", action_url: { in: actionUrls } },
				select: { technician_id: true, action_url: true },
			});
			const sentKeys = new Set(
				existingReminders.map(r => `${r.action_url}:${r.technician_id}`)
			);

			for (const visit of upcoming) {
				const orgId = visit.job.organization_id;
				if (!orgId) continue;
				const clientName = visit.job.client.name;
				const actionUrl  = `/technician/visits/${visit.id}`;

				for (const { tech_id } of visit.visit_techs) {
					if (sentKeys.has(`${actionUrl}:${tech_id}`)) continue;

					await notificationsController.createNotification({
						technicianId: tech_id,
						type: "visit_reminder",
						title: `Visit in 30 minutes: ${clientName}`,
						body: `Your visit at ${clientName} starts in about 30 minutes.`,
						actionUrl,
					}, orgId);
				}
			}
		} catch (e) {
			log.error({ err: e }, "Visit reminder interval failed");
		}
	}, 60_000);
}
