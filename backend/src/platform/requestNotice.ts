import { db } from "../db.js";
import { log } from "../services/appLogger.js";
import {
	createDispatcherNotification,
	notifyDispatchers,
} from "../controllers/notificationsController.js";

const TYPE = "upgrade_request_resolved" as const;

export async function notifyRequestResolved(
	orgId: string,
	requestId: string,
	outcome: "approved" | "declined",
	note: string,
): Promise<void> {
	try {
		const notice = {
			type: TYPE,
			title: `Your subscription request was ${outcome}`,
			body: note,
			actionUrl: "/dispatch/admin?tab=entitlements",
		};
		const request = await db.upgrade_request.findUnique({
			where: { id: requestId },
			select: { requested_by_id: true },
		});
		const requester = request
			? await db.dispatcher.findFirst({
					where: {
						id: request.requested_by_id,
						organization_id: orgId,
						deactivated_at: null,
					},
					select: {
						id: true,
						role: true,
						muted_notification_types: true,
						organization_role: { select: { permissions: true } },
					},
				})
			: null;
		const requesterCanManage =
			!!requester &&
			(requester.role === "admin" ||
				!!requester.organization_role?.permissions.includes(
					"manage_organization",
				));
		// The answer goes to whoever asked. If they have since left or lost the permission, every
		// manager hears it instead so it is not lost; a requester who muted it hears nothing.
		if (requesterCanManage) {
			if (requester.muted_notification_types.includes(TYPE)) return;
			await createDispatcherNotification(
				{ ...notice, dispatcherId: requester.id },
				orgId,
			);
			return;
		}
		await notifyDispatchers(notice, orgId);
	} catch (err) {
		log.warn(
			{ err, orgId, requestId },
			"upgrade_request_resolved notification failed",
		);
	}
}
