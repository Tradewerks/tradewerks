import { db } from "../db.js";
import { getScopedDb } from "../lib/context.js";
import type { email_template_category } from "../../generated/prisma/client.js";
import type { UpsertTemplateInput } from "../lib/validate/emailTemplates.js";
import {
	deleteTemplate,
	loadTemplate,
	saveTemplate,
	type TemplateDefaults,
} from "../services/emailTemplateStore.js";
import { DEFAULT_NOTIFICATION_TEMPLATES } from "../services/customerComms/templateDefaults.js";
import {
	CUSTOMER_EVENTS,
	type CustomerEvent,
} from "../services/customerComms/events.js";
import { smsUnavailableReason } from "../services/sms/smsAvailability.js";
import {
	DEFAULT_LATE_CONFIG,
	DEFAULT_REMINDER_CONFIG,
	DEFAULT_REVIEW_CONFIG,
	type UpdateSettingInput,
} from "../lib/validate/customerComms.js";
import { redactLinks } from "../lib/redactLinks.js";

export const EVENT_META: Record<
	CustomerEvent,
	{ label: string; description: string }
> = {
	visit_confirmed: {
		label: "Visit confirmed",
		description: "Sent when a visit is scheduled with a date and time.",
	},
	visit_reminder: {
		label: "Visit reminder",
		description: "Sent ahead of the visit, at the lead times you choose.",
	},
	visit_rescheduled: {
		label: "Visit rescheduled",
		description: "Sent when a scheduled visit moves to a new time.",
	},
	visit_cancelled: {
		label: "Visit cancelled",
		description: "Sent when a scheduled visit is cancelled.",
	},
	tech_on_the_way: {
		label: "Technician on the way",
		description: "Sent when a technician starts driving to the visit.",
	},
	tech_running_late: {
		label: "Technician running late",
		description:
			"Sent when a technician is forecast to arrive later than planned, once the delay passes the threshold you set.",
	},
	visit_completed: {
		label: "Visit completed",
		description: "Sent when a visit is marked complete.",
	},
	review_request: {
		label: "Review request",
		description:
			"Sent after a job is completed, asking for a review. At most once per client every 180 days.",
	},
};

const DEFAULT_CONFIG: Partial<
	Record<CustomerEvent, { key: string; value: Record<string, unknown> }>
> = {
	visit_reminder: { key: "lead_hours", value: DEFAULT_REMINDER_CONFIG },
	review_request: { key: "delay_hours", value: DEFAULT_REVIEW_CONFIG },
	tech_running_late: { key: "threshold_minutes", value: DEFAULT_LATE_CONFIG },
};

const reviewUrlOf = async (orgId: string) =>
	(
		await db.organization.findUnique({
			where: { id: orgId },
			select: { review_url: true },
		})
	)?.review_url ?? null;

export async function listSettings(orgId: string) {
	const [rows, smsUnavailable, reviewUrl] = await Promise.all([
		getScopedDb(orgId).customer_notification_setting.findMany({}),
		smsUnavailableReason(orgId),
		reviewUrlOf(orgId),
	]);
	const smsAvailable = smsUnavailable === null;
	const byEvent = new Map(rows.map((r) => [r.event, r]));
	return CUSTOMER_EVENTS.map((event) => {
		const row = byEvent.get(event);
		const stored = (row?.config ?? {}) as Record<string, unknown>;
		const def = DEFAULT_CONFIG[event];
		return {
			event,
			...EVENT_META[event],
			email_enabled: row?.email_enabled ?? false,
			sms_enabled: row?.sms_enabled ?? false,
			config: def && !(def.key in stored) ? def.value : stored,
			sms_available: smsAvailable,
			...(event === "review_request" ? { review_url: reviewUrl } : {}),
		};
	});
}

/** Whether this change would leave the review request on with no link to send. */
export async function reviewUrlMissing(
	orgId: string,
	input: UpdateSettingInput,
): Promise<boolean> {
	const current = await getScopedDb(
		orgId,
	).customer_notification_setting.findFirst({
		where: { event: "review_request" },
		select: { email_enabled: true, sms_enabled: true },
	});
	const on =
		(input.email_enabled ?? current?.email_enabled ?? false) ||
		(input.sms_enabled ?? current?.sms_enabled ?? false);
	if (!on) return false;
	const url =
		input.review_url !== undefined
			? input.review_url
			: await reviewUrlOf(orgId);
	return !url;
}

export async function updateSetting(
	orgId: string,
	event: CustomerEvent,
	input: UpdateSettingInput,
) {
	const data: Record<string, unknown> = {};
	if (input.email_enabled !== undefined)
		data.email_enabled = input.email_enabled;
	if (input.sms_enabled !== undefined) data.sms_enabled = input.sms_enabled;
	if (input.config !== undefined) data.config = input.config;
	const reviewUrl = input.review_url;
	// The link and the switch that depends on it land together or not at all.
	await getScopedDb(orgId).$transaction(async (tx) => {
		if (reviewUrl !== undefined)
			await tx.organization.update({
				where: { id: orgId },
				data: { review_url: reviewUrl },
			});
		await tx.customer_notification_setting.upsert({
			where: { organization_id_event: { organization_id: orgId, event } },
			update: data,
			create: { organization_id: orgId, event, ...data },
		});
	});
	return (await listSettings(orgId)).find((e) => e.event === event)!;
}

export async function listMessages(
	orgId: string,
	q: {
		entity_type?: string;
		entity_id?: string;
		client_id?: string;
		limit: number;
	},
) {
	const rows = await getScopedDb(orgId).customer_message.findMany({
		where: {
			...(q.entity_type ? { entity_type: q.entity_type } : {}),
			...(q.entity_id ? { entity_id: q.entity_id } : {}),
			...(q.client_id ? { client_id: q.client_id } : {}),
		},
		orderBy: { created_at: "desc" },
		take: q.limit,
		select: {
			id: true,
			direction: true,
			event: true,
			channel: true,
			client_id: true,
			contact_id: true,
			recipient: true,
			entity_type: true,
			entity_id: true,
			status: true,
			skip_reason: true,
			subject: true,
			body: true,
			segments: true,
			error: true,
			send_after: true,
			sent_at: true,
			delivered_at: true,
			opened_at: true,
			created_at: true,
		},
	});
	// A queued or sending row still holds the live link a retry resends.
	return rows.map((r) => ({ ...r, body: redactLinks(r.body) }));
}

function defaultsFor(event: CustomerEvent): TemplateDefaults {
	const def = DEFAULT_NOTIFICATION_TEMPLATES[event];
	return {
		name: EVENT_META[event].label,
		subject: def.subject,
		html: def.html,
		text: def.text,
		sms_body: def.sms,
	};
}

const asCategory = (event: CustomerEvent) => event as email_template_category;

/** The org's saved message for an event, else the built-in one. */
export const getTemplate = (orgId: string, event: CustomerEvent) =>
	loadTemplate(orgId, asCategory(event), defaultsFor(event));

export const upsertTemplate = (
	orgId: string,
	event: CustomerEvent,
	input: UpsertTemplateInput,
	dispatcherId: string | null,
) =>
	saveTemplate(
		orgId,
		asCategory(event),
		input,
		dispatcherId,
		EVENT_META[event].label,
	);

export const resetTemplate = (orgId: string, event: CustomerEvent) =>
	deleteTemplate(orgId, asCategory(event), defaultsFor(event));
