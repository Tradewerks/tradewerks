import type { email_template_category } from "../../../generated/prisma/client.js";
import { getScopedDb } from "../../lib/context.js";
import {
	issueLink,
	issueMessageLink,
	linkExpiry,
	unsubscribeHeaders,
} from "../../lib/publicLink.js";
import { htmlToText } from "../htmlToText.js";
import { getOrgBrandModel } from "../emailBranding.js";
import { renderTemplate } from "../templateRenderer.js";
import { buildVisitModel } from "../visitMessageModel.js";
import { log } from "../appLogger.js";
import { signImageUrl } from "../wasabiService.js";
import type { CustomerEvent } from "./events.js";
import {
	DEFAULT_NOTIFICATION_TEMPLATES,
	type NotificationTemplate,
} from "./templateDefaults.js";

// An email is opened long after it is sent, so its photo gets the longest
// signature S3 allows instead of the visit page's hour.
const EMAIL_PHOTO_TTL_SECONDS = 7 * 24 * 3600;

export interface RenderedMessage {
	subject?: string;
	html?: string;
	text: string;
	/**
	 * List-Unsubscribe headers. Built here, not at send time, so a missing base
	 * URL fails the render, which retries, rather than the send.
	 */
	headers?: { Name: string; Value: string }[];
}

export interface RenderInput {
	event: CustomerEvent;
	channel: string;
	entity_type: string;
	entity_id: string;
	client_id: string | null;
	contact_id: string | null;
}

/** The org's saved template for the event, else the built-in one. */
async function loadTemplate(
	orgId: string,
	event: CustomerEvent,
): Promise<NotificationTemplate> {
	const def = DEFAULT_NOTIFICATION_TEMPLATES[event];
	const row = await getScopedDb(orgId).email_template.findFirst({
		where: { category: event as email_template_category },
		select: { subject: true, html: true, text: true, sms_body: true },
	});
	if (!row) return def;
	return {
		subject: row.subject,
		html: row.html,
		// A saved row with no text part lets the send path derive it from the HTML.
		text: row.text ?? "",
		sms: row.sms_body ?? def.sms,
	};
}

/**
 * Renders a queued message from current data. Returns a skip reason when the
 * message has nothing true left to say (its visit is gone).
 */
export async function renderCustomerMessage(
	orgId: string,
	msg: RenderInput,
	tz: string,
): Promise<RenderedMessage | { skip: string }> {
	const sdb = getScopedDb(orgId);
	const model: Record<string, unknown> = {
		...(await getOrgBrandModel(orgId)),
		client_name: "",
		unsubscribe_url: "",
	};
	if (msg.client_id) {
		const client = await sdb.client.findFirst({
			where: { id: msg.client_id },
			select: { name: true },
		});
		model.client_name = client?.name ?? "";
	}
	let techPhoto: string | null = null;
	if (msg.entity_type === "job_visit") {
		const visit = await buildVisitModel(sdb, msg.entity_id, tz);
		if (!visit) return { skip: "visit_not_found" };
		const { tech_photo_raw_url, ...fields } = visit;
		techPhoto = tech_photo_raw_url;
		Object.assign(model, fields);
	}
	let headers: RenderedMessage["headers"];
	if (msg.channel === "email" && msg.contact_id) {
		const link = await issueLink(orgId, {
			purpose: "unsubscribe",
			entityId: msg.contact_id,
			contactId: msg.contact_id,
		});
		model.unsubscribe_url = link.url;
		headers = unsubscribeHeaders(link.token);
	}

	const t = await loadTemplate(orgId, msg.event);
	const body = msg.channel === "sms" ? t.sms : t.subject + t.html + t.text;
	if (
		msg.channel === "email" &&
		techPhoto &&
		body.includes("tech.photo_url")
	) {
		try {
			model.tech = {
				...(model.tech as object),
				photo_url: await signImageUrl(
					techPhoto,
					EMAIL_PHOTO_TTL_SECONDS,
				),
			};
		} catch (err) {
			log.warn(
				{ err, orgId },
				"tech photo could not be signed; sent without it",
			);
		}
	}
	// Issued only when the template uses it, so every visit message doesn't mint a link row.
	if (
		msg.entity_type === "job_visit" &&
		msg.contact_id &&
		body.includes("link.visit")
	) {
		const v = await sdb.job_visit.findFirst({
			where: { id: msg.entity_id },
			select: {
				scheduled_end_at: true,
				status: true,
				actual_end_at: true,
			},
		});
		// Re-issuing for the same visit and contact returns the same token with
		// its expiry set from the visit as it is now (rescheduled or completed).
		const visit = v
			? await issueMessageLink(orgId, {
					purpose: "visit",
					entityId: msg.entity_id,
					contactId: msg.contact_id,
					expiresAt: linkExpiry("visit", v),
				})
			: null;
		model.link = { visit: visit ?? "" };
	}
	if (msg.channel === "sms") {
		return { text: renderTemplate(t.sms, model, { escape: false }) };
	}
	const html = renderTemplate(t.html, model);
	const text = t.text.trim()
		? renderTemplate(t.text, model, { escape: false })
		: htmlToText(html);
	return {
		subject: renderTemplate(t.subject, model, { escape: false }),
		html,
		text,
		headers,
	};
}
