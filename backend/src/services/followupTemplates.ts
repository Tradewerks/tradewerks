import { db } from "../db.js";
import type { email_template_category } from "../../generated/prisma/client.js";
import { DEFAULT_TEMPLATES } from "./followupTemplateDefaults.js";
import type { EmailTemplateCategoryValue } from "../lib/validate/emailTemplates.js";

export interface EffectiveTemplate {
	category: email_template_category;
	name: string;
	subject: string;
	html: string;
	/** Editable plain-text alternative. null = auto-generate from the HTML at send time. */
	text: string | null;
	/** Text-message body. Only customer-message templates use it; null otherwise. */
	sms_body: string | null;
	/** true when the org has saved an override; false when this is the built-in default. */
	is_customized: boolean;
	updated_at: Date | null;
}

export const TEMPLATE_CATEGORIES = Object.keys(
	DEFAULT_TEMPLATES,
) as email_template_category[];

/**
 * Resolve the subject + html to send for an org's category: the saved override
 * if one exists, otherwise the built-in default. Used at send time (scheduler).
 */
export async function getEffectiveTemplate(
	orgId: string,
	category: email_template_category,
): Promise<{ subject: string; html: string; text: string | null }> {
	const row = await db.email_template.findUnique({
		where: { organization_id_category: { organization_id: orgId, category } },
		select: { subject: true, html: true, text: true },
	});
	// For a saved override, honor its text as-is (null → send path auto-generates
	// from the HTML). For the default, ship the default's plain-text body.
	if (row) return { subject: row.subject, html: row.html, text: row.text };
	const def =
		DEFAULT_TEMPLATES[category as EmailTemplateCategoryValue] ?? DEFAULT_TEMPLATES.followup;
	return { subject: def.subject, html: def.html, text: def.text };
}

/** Merge an org's saved overrides over the defaults, one entry per category. */
export async function listEffectiveTemplates(orgId: string): Promise<EffectiveTemplate[]> {
	const rows = await db.email_template.findMany({
		where: { organization_id: orgId },
	});
	const byCategory = new Map(rows.map((r) => [r.category, r]));

	return TEMPLATE_CATEGORIES.map((category) => {
		const def = DEFAULT_TEMPLATES[category as EmailTemplateCategoryValue];
		const row = byCategory.get(category);
		return row
			? {
					category,
					name: row.name,
					subject: row.subject,
					html: row.html,
					text: row.text,
					sms_body: row.sms_body,
					is_customized: true,
					updated_at: row.updated_at,
				}
			: {
					category,
					name: def.name,
					subject: def.subject,
					html: def.html,
					text: def.text,
					sms_body: null,
					is_customized: false,
					updated_at: null,
				};
	});
}
