import { log } from "../services/appLogger.js";
import type { Server } from "socket.io";
import { getScopedDb } from "../lib/context.js";
import type z from "zod";
import type { DispatcherNotificationTypeEnum } from "../lib/validate/dispatchers.js";

// ── Types ─────────────────────────────────────────────────────────────────────

// technician types
export type NotificationType =
	| "visit_assigned"
	| "visit_changed"
	| "visit_cancelled"
	| "note_added"
	| "visit_reminder"
	| "field_purchase_preauth"
	| "field_purchase_reviewed"
	| "vehicle_maintenance_due"
	| "tech_running_late";

export type DispatcherNotificationType = z.infer<typeof DispatcherNotificationTypeEnum>;

// ── Socket.io injection ───────────────────────────────────────────────────────

let _io: Server | null = null;
export function setSocketIo(io: Server) { _io = io; }

// technician's create notification input
interface CreateNotificationInput {
	technicianId: string;
	type:         NotificationType;
	title:        string;
	body:         string;
	actionUrl?:   string;
}

interface CreateDispatcherNotificationInput {
	dispatcherId: 	string;
	type:			DispatcherNotificationType;
	title:			string;
	body:			string;
	actionUrl?:		string;
}

// ── Internal: create a notification ─────────────────────────────────────────

// create a technician notification
export const createNotification = async (input: CreateNotificationInput, organizationId: string) => {
	let created;
	try {
		const sdb = getScopedDb(organizationId);
		created = await sdb.technician_notification.create({
			data: {
				technician_id: input.technicianId,
				type:          input.type,
				title:         input.title,
				body:          input.body,
				action_url:    input.actionUrl ?? null,
			},
		});
	} catch (e) {
		// For a field-purchase decision this row is the technician's only channel
		// for money they are owed or a receipt they have to fix. The durable trail
		// (`field_purchase_event`) still holds the decision, but nothing tells them.
		log.error(
			{ err: e, technicianId: input.technicianId, type: input.type, organizationId },
			"Technician notification NOT created — the technician has no other channel for this",
		);
		return null;
	}

	// Separate from the write above: the row exists, and a socket that is down must
	// not make a created notification look to the caller like a failed one.
	try {
		_io?.to(`tech:${input.technicianId}`).emit("notification:new", created);
	} catch (e) {
		log.error(
			{ err: e, technicianId: input.technicianId, type: input.type, notificationId: created.id },
			"Notification created but the real-time push failed — the technician sees it on next poll",
		);
	}
	return created;
};

export const createDispatcherNotification = async (input: CreateDispatcherNotificationInput, orgId: string) => {
	let created;
	try{
		const sdb = getScopedDb(orgId);
		created = await sdb.dispatcher_notification.create({
			data: {
				dispatcher_id: input.dispatcherId,
				type:          input.type,
				title:         input.title,
				body:          input.body,
				action_url:    input.actionUrl ?? null,
			},
		});
	} catch (e) {
		log.error(
			{ err: e, dispatcherId: input.dispatcherId, type: input.type, orgId },
			"Dispatcher notification NOT created — the dispatcher has no other channel for this",
		);
		return null;
	}

	// Separate from the write above: the row exists, and a socket that is down must
	// not make a created notification look to the caller like a failed one.
	try {
		_io?.to(`dispatcher:${input.dispatcherId}`).emit("notification:new", created);
	} catch (e) {
		log.error(
			{ err: e, dispatcherId: input.dispatcherId, type: input.type, notificationId: created.id },
			"Notification created but the real-time push failed — the dispatcher sees it on next poll",
		);
	}
	return created;
}

// Permission a dispatcher needs to receive each type (admins receive all)
export const DISPATCHER_NOTIFICATION_PERMISSIONS: Record<DispatcherNotificationType, string> = {
	vehicle_maintenance_due: "view_vehicles",
	job_finished: "view_jobs",
	visit_delayed: "view_jobs",
	tech_running_late: "view_jobs",
	tech_note_added: "view_jobs",
	followup_email_opened: "view_followups",
	field_purchase_preauth_requested: "review_field_purchases",
	field_purchase_submitted: "review_field_purchases",
	field_purchase_second_signoff: "second_sign_off_field_purchases",
	field_purchase_grant_requested: "manage_field_purchase_grants",
	restock_shortfall: "view_inventory",
	vehicle_restock_requested: "view_inventory",
	dispute_opened: "resolve_disputes",
	invoice_paid: "view_invoices",
	quote_accepted: "view_quotes",
	quote_declined: "view_quotes",
	usage_limit_warning: "manage_organization",
	subscription_changed: "manage_organization",
	upgrade_request_resolved: "manage_organization",
};

// Notify every dispatcher in the org who can see this type and hasn't muted it
export const notifyDispatchers = async (
	input: Omit<CreateDispatcherNotificationInput, "dispatcherId">,
	orgId: string,
	excludeDispatcherId?: string,
) => {
	const sdb = getScopedDb(orgId);
	const permission = DISPATCHER_NOTIFICATION_PERMISSIONS[input.type];
	const recipients = await sdb.dispatcher.findMany({
		where: {
			deactivated_at: null,
			NOT: { muted_notification_types: { has: input.type } },
			OR: [{ role: "admin" }, { organization_role: { permissions: { has: permission } } }],
			...(excludeDispatcherId && { id: { not: excludeDispatcherId } }),
		},
		select: { id: true },
	});
	return Promise.all(
		recipients.map((d) => createDispatcherNotification({ ...input, dispatcherId: d.id }, orgId)),
	);
};

// ── API handlers ──────────────────────────────────────────────────────────────

export const listNotifications = async (technicianId: string, unreadOnly = false, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const notifications = await sdb.technician_notification.findMany({
		where: {
			technician_id: technicianId,
			...(unreadOnly && { read_at: null }),
		},
		orderBy: { created_at: "desc" },
	});
	return notifications;
};

export const listDispatcherNotifications = async (dispatcherId: string, unreadOnly = false, orgId: string) => {
	const sdb = getScopedDb(orgId);
	const notifications = await sdb.dispatcher_notification.findMany({
		where: {
			dispatcher_id: dispatcherId,
			...(unreadOnly && { read_at: null }),
		},
		orderBy: { created_at: "desc" },
	});
	return notifications;
}

export const markNotificationRead = async (technicianId: string, notifId: string, organizationId: string) => {
	try {
		const sdb = getScopedDb(organizationId);
		const notif = await sdb.technician_notification.findFirst({
			where: { id: notifId, technician_id: technicianId },
		});
		if (!notif) return { err: "Notification not found" };

		const updated = await sdb.technician_notification.update({
			where: { id: notifId },
			data: { read_at: notif.read_at ?? new Date() },
		});
		return { err: "", item: updated };
	} catch (e) {
		log.error({ err: e }, "Failed to mark notification read");
		return { err: "Failed to mark notification read" };
	}
};

export const markDispatcherNotificationRead = async (dispatcherId: string, notifId: string, organizationId: string) => {
	try {
		const sdb = getScopedDb(organizationId);
		const notif = await sdb.dispatcher_notification.findFirst({
			where: { id: notifId, dispatcher_id: dispatcherId },
		});
		if (!notif) return { err: "Notification not found" };

		const updated = await sdb.dispatcher_notification.update({
			where: { id: notifId },
			data: { read_at: notif.read_at ?? new Date() },
		});
		return { err: "", item: updated };
	} catch (e) {
		log.error({ err: e }, "Failed to mark notification read");
		return { err: "Failed to mark notification read" };
	}
};

export const markAllNotificationsRead = async (technicianId: string, organizationId: string) => {
	try {
		const sdb = getScopedDb(organizationId);
		await sdb.technician_notification.updateMany({
			where: { technician_id: technicianId, read_at: null },
			data:  { read_at: new Date() },
		});
		return { err: "" };
	} catch (e) {
		log.error({ err: e }, "Failed to mark all notifications read");
		return { err: "Failed to mark all notifications read" };
	}
};

export const markAllDispatcherNotificationsRead = async (dispatcherId: string, organizationId: string) => {
	try {
		const sdb = getScopedDb(organizationId);
		await sdb.dispatcher_notification.updateMany({
			where: { dispatcher_id: dispatcherId, read_at: null },
			data:  { read_at: new Date() },
		});
		return { err: "" };
	} catch (e) {
		log.error({ err: e }, "Failed to mark all notifications read");
		return { err: "Failed to mark all notifications read" };
	}
};
